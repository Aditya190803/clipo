/**
 * Clipo - Storage Module
 * Handles persistence of clipboard history using a compacting log
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { ClipboardEntry, LinkedList } from './dataStructures.js';

// Operation types for the binary log
const OP_TYPE_SAVE_TEXT = 1;
const OP_TYPE_SAVE_IMAGE = 2;
const OP_TYPE_DELETE = 3;
const OP_TYPE_PIN = 4;
const OP_TYPE_UNPIN = 5;
const OP_TYPE_MOVE_TO_TOP = 6;

// Thresholds
const COMPACT_THRESHOLD = 500; // Compact after this many wasted operations
const FLUSH_INTERVAL = 1000; // Flush every N entries during bulk writes

function toGLibBytes(data) {
    if (!data)
        return null;

    if (data instanceof GLib.Bytes)
        return data;

    if (data instanceof Uint8Array)
        return new GLib.Bytes(data);

    return new GLib.Bytes(data);
}

export class Store {
    constructor(settings) {
        this.settings = settings;
        this._nextId = 1;
        this._nextDiskId = 1;
        this._uselessOpCount = 0;
        this._opQueue = Promise.resolve();
        
        // Initialize storage directory
        this._cacheDir = GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            'clipo'
        ]);
        this._dbPath = GLib.build_filenamev([this._cacheDir, 'database.log']);
        this._imageCacheDir = GLib.build_filenamev([this._cacheDir, 'images']);
        
        this._ensureDirectories();
    }
    
    /**
     * Ensure required directories exist
     */
    _ensureDirectories() {
        const cacheDir = Gio.File.new_for_path(this._cacheDir);
        if (!cacheDir.query_exists(null)) {
            cacheDir.make_directory_with_parents(null);
        }
        
        const imageDir = Gio.File.new_for_path(this._imageCacheDir);
        if (!imageDir.query_exists(null)) {
            imageDir.make_directory_with_parents(null);
        }
    }
    
    /**
     * Generate next unique ID
     */
    getNextId() {
        return this._nextId++;
    }
    
    /**
     * Generate next disk ID
     */
    getNextDiskId() {
        return this._nextDiskId++;
    }
    
    /**
     * Initialize store and load history from disk
     * @returns {{history: LinkedList, pinned: LinkedList}}
     */
    init() {
        const history = new LinkedList();
        const pinned = new LinkedList();

        if (!this.settings.get_boolean('persist-history')) {
            return { history, pinned };
        }
        
        const dbFile = Gio.File.new_for_path(this._dbPath);
        if (!dbFile.query_exists(null)) {
            return { history, pinned };
        }
        
        try {
            const entries = this._loadFromLogSync();
            
            // Separate pinned and unpinned entries
            for (const entry of entries) {
                if (entry.pinned) {
                    pinned.append(entry);
                } else {
                    history.append(entry);
                }
                
                // Track highest IDs
                if (entry.id >= this._nextId) {
                    this._nextId = entry.id + 1;
                }
                if (entry.diskId && entry.diskId >= this._nextDiskId) {
                    this._nextDiskId = entry.diskId + 1;
                }
            }
        } catch (e) {
            console.error('[Clipo] Failed to load history:', e);
            // Move corrupted database
            this._handleCorruptedDatabase();
        }
        
        return { history, pinned };
    }
    
    /**
     * Load entries from the log file (synchronous)
     */
    _loadFromLogSync() {
        const entries = new Map(); // diskId -> entry
        const file = Gio.File.new_for_path(this._dbPath);
        
        if (!file.query_exists(null)) {
            return [];
        }
        
        const stream = file.read(null);
        const dataStream = Gio.DataInputStream.new(stream);
        dataStream.set_byte_order(Gio.DataStreamByteOrder.LITTLE_ENDIAN);
        
        try {
            while (true) {
                // Read operation type
                const opType = dataStream.read_byte(null);
                if (opType === 0) break; // EOF or invalid
                
                switch (opType) {
                    case OP_TYPE_SAVE_TEXT: {
                        const diskId = dataStream.read_uint32(null);
                        const timestamp = dataStream.read_int64(null);
                        const pinned = dataStream.read_byte(null) === 1;
                        
                        // Read plain text
                        const plainLen = dataStream.read_uint32(null);
                        let plain = null;
                        if (plainLen > 0) {
                            const plainBytes = dataStream.read_bytes(plainLen, null);
                            plain = new TextDecoder().decode(plainBytes.get_data());
                        }
                        
                        // Read rich text
                        const richLen = dataStream.read_uint32(null);
                        let rich = null;
                        if (richLen > 0) {
                            const richBytes = dataStream.read_bytes(richLen, null);
                            rich = new TextDecoder().decode(richBytes.get_data());
                        }
                        
                        const entry = new ClipboardEntry(this.getNextId(), 'text', { plain, rich });
                        entry.diskId = diskId;
                        entry.timestamp = Number(timestamp);
                        entry.pinned = pinned;
                        
                        entries.set(diskId, entry);
                        break;
                    }
                    
                    case OP_TYPE_SAVE_IMAGE: {
                        const diskId = dataStream.read_uint32(null);
                        const timestamp = dataStream.read_int64(null);
                        const pinned = dataStream.read_byte(null) === 1;
                        
                        // Read image path
                        const pathLen = dataStream.read_uint32(null);
                        let imagePath = null;
                        if (pathLen > 0) {
                            const pathBytes = dataStream.read_bytes(pathLen, null);
                            imagePath = new TextDecoder().decode(pathBytes.get_data());
                        }
                        
                        // Load image data if file exists
                        let imageData = null;
                        if (imagePath) {
                            const imageFile = Gio.File.new_for_path(imagePath);
                            if (imageFile.query_exists(null)) {
                                const [, contents] = imageFile.load_contents(null);
                                imageData = contents;
                            }
                        }
                        
                        if (imageData) {
                            const entry = new ClipboardEntry(this.getNextId(), 'image', imageData);
                            entry.diskId = diskId;
                            entry.timestamp = Number(timestamp);
                            entry.pinned = pinned;
                            entry._imagePath = imagePath;
                            
                            entries.set(diskId, entry);
                        }
                        break;
                    }
                    
                    case OP_TYPE_DELETE: {
                        const diskId = dataStream.read_uint32(null);
                        entries.delete(diskId);
                        this._uselessOpCount++;
                        break;
                    }
                    
                    case OP_TYPE_PIN: {
                        const diskId = dataStream.read_uint32(null);
                        const entry = entries.get(diskId);
                        if (entry) entry.pinned = true;
                        break;
                    }
                    
                    case OP_TYPE_UNPIN: {
                        const diskId = dataStream.read_uint32(null);
                        const entry = entries.get(diskId);
                        if (entry) entry.pinned = false;
                        break;
                    }
                    
                    case OP_TYPE_MOVE_TO_TOP: {
                        // This is handled by order in compacted log
                        dataStream.read_uint32(null);
                        this._uselessOpCount++;
                        break;
                    }
                    
                    default:
                        console.warn(`[Clipo] Unknown operation type: ${opType}`);
                        break;
                }
            }
        } catch (e) {
            if (!e.matches || !e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED)) {
                console.error('[Clipo] Error reading log:', e);
            }
        }
        
        stream.close(null);
        
        // Return entries sorted by timestamp (newest first)
        return Array.from(entries.values()).sort((a, b) => b.timestamp - a.timestamp);
    }
    
    /**
     * Handle corrupted database file
     */
    _handleCorruptedDatabase() {
        const dbFile = Gio.File.new_for_path(this._dbPath);
        const corruptedPath = GLib.build_filenamev([this._cacheDir, 'corrupted.log']);
        const corruptedFile = Gio.File.new_for_path(corruptedPath);
        
        try {
            dbFile.move(corruptedFile, Gio.FileCopyFlags.OVERWRITE, null, null);
            console.log('[Clipo] Moved corrupted database to corrupted.log');
        } catch (e) {
            console.error('[Clipo] Failed to move corrupted database:', e);
        }
    }
    
    /**
     * Queue an async operation
     */
    _queueOp(operation) {
        this._opQueue = this._opQueue.then(operation).catch(e => {
            console.error('[Clipo] Operation failed:', e);
        });
        return this._opQueue;
    }
    
    /**
     * Save a text entry to disk
     */
    saveTextEntry(entry) {
        if (!this.settings.get_boolean('persist-history')) {
            return;
        }
        
        if (this.settings.get_boolean('save-only-pinned') && !entry.pinned) {
            return;
        }
        
        return this._queueOp(() => {
            if (!entry.diskId) {
                entry.diskId = this.getNextDiskId();
            }
            
            const file = Gio.File.new_for_path(this._dbPath);
            const stream = file.append_to(
                Gio.FileCreateFlags.NONE,
                null
            );
            const dataStream = Gio.DataOutputStream.new(stream);
            dataStream.set_byte_order(Gio.DataStreamByteOrder.LITTLE_ENDIAN);
            
            // Write operation
            dataStream.put_byte(OP_TYPE_SAVE_TEXT, null);
            dataStream.put_uint32(entry.diskId, null);
            dataStream.put_int64(entry.timestamp, null);
            dataStream.put_byte(entry.pinned ? 1 : 0, null);
            
            // Write plain text
            const plainBytes = entry.plain ? new TextEncoder().encode(entry.plain) : new Uint8Array(0);
            dataStream.put_uint32(plainBytes.length, null);
            if (plainBytes.length > 0) {
                dataStream.write_bytes(new GLib.Bytes(plainBytes), null);
            }
            
            // Write rich text
            const richBytes = entry.rich ? new TextEncoder().encode(entry.rich) : new Uint8Array(0);
            dataStream.put_uint32(richBytes.length, null);
            if (richBytes.length > 0) {
                dataStream.write_bytes(new GLib.Bytes(richBytes), null);
            }
            
            stream.close(null);
            
            this._maybeCompact();
        });
    }
    
    /**
     * Save an image entry to disk
     */
    saveImageEntry(entry) {
        if (!this.settings.get_boolean('persist-history')) {
            return;
        }
        
        if (!this.settings.get_boolean('enable-images')) {
            return;
        }
        
        if (this.settings.get_boolean('save-only-pinned') && !entry.pinned) {
            return;
        }
        
        return this._queueOp(() => {
            if (!entry.diskId) {
                entry.diskId = this.getNextDiskId();
            }
            
            // Save image to file
            const imagePath = GLib.build_filenamev([
                this._imageCacheDir,
                `${entry.diskId}.png`
            ]);
            entry._imagePath = imagePath;
            
            const imageFile = Gio.File.new_for_path(imagePath);
            const imageStream = imageFile.replace(
                null,
                false,
                Gio.FileCreateFlags.NONE,
                null
            );

            const imageBytes = toGLibBytes(entry.imageData);
            if (imageBytes) {
                imageStream.write_bytes(imageBytes, null);
            }
            imageStream.close(null);
            
            // Write to log
            const file = Gio.File.new_for_path(this._dbPath);
            const stream = file.append_to(
                Gio.FileCreateFlags.NONE,
                null
            );
            const dataStream = Gio.DataOutputStream.new(stream);
            dataStream.set_byte_order(Gio.DataStreamByteOrder.LITTLE_ENDIAN);
            
            dataStream.put_byte(OP_TYPE_SAVE_IMAGE, null);
            dataStream.put_uint32(entry.diskId, null);
            dataStream.put_int64(entry.timestamp, null);
            dataStream.put_byte(entry.pinned ? 1 : 0, null);
            
            const pathBytes = new TextEncoder().encode(imagePath);
            dataStream.put_uint32(pathBytes.length, null);
            dataStream.write_bytes(new GLib.Bytes(pathBytes), null);
            
            stream.close(null);
            
            this._maybeCompact();
        });
    }
    
    /**
     * Delete an entry from disk
     */
    deleteEntry(entry) {
        if (!entry.diskId) {
            return;
        }
        
        return this._queueOp(() => {
            const file = Gio.File.new_for_path(this._dbPath);
            const stream = file.append_to(
                Gio.FileCreateFlags.NONE,
                null
            );
            const dataStream = Gio.DataOutputStream.new(stream);
            dataStream.set_byte_order(Gio.DataStreamByteOrder.LITTLE_ENDIAN);
            
            dataStream.put_byte(OP_TYPE_DELETE, null);
            dataStream.put_uint32(entry.diskId, null);
            
            stream.close(null);
            
            // Delete image file if exists
            if (entry._imagePath) {
                try {
                    const imageFile = Gio.File.new_for_path(entry._imagePath);
                    imageFile.delete(null);
                } catch (e) {
                    // Ignore if file doesn't exist
                }
            }
            
            this._uselessOpCount++;
            this._maybeCompact();
        });
    }
    
    /**
     * Update pin status
     */
    updatePinStatus(entry, pinned) {
        if (!entry.diskId) {
            // If not on disk yet, save it
            if (pinned) {
                if (entry.type === 'text') {
                    return this.saveTextEntry(entry);
                } else {
                    return this.saveImageEntry(entry);
                }
            }
            return;
        }
        
        return this._queueOp(() => {
            const file = Gio.File.new_for_path(this._dbPath);
            const stream = file.append_to(
                Gio.FileCreateFlags.NONE,
                null
            );
            const dataStream = Gio.DataOutputStream.new(stream);
            dataStream.set_byte_order(Gio.DataStreamByteOrder.LITTLE_ENDIAN);
            
            dataStream.put_byte(pinned ? OP_TYPE_PIN : OP_TYPE_UNPIN, null);
            dataStream.put_uint32(entry.diskId, null);
            
            stream.close(null);
        });
    }

    syncFromLists(historyEntries, pinnedEntries) {
        return this._queueOp(() => {
            if (!this.settings.get_boolean('persist-history')) {
                this._clearPersistedData();
                return;
            }

            const saveOnlyPinned = this.settings.get_boolean('save-only-pinned');
            const entries = saveOnlyPinned
                ? [...pinnedEntries]
                : [...pinnedEntries, ...historyEntries];

            this._rewritePersistedEntries(entries);
        });
    }
    
    /**
     * Compact the log if needed
     */
    _maybeCompact() {
        if (this._uselessOpCount < COMPACT_THRESHOLD || this._isCompacting) {
            return;
        }
        
        console.log('[Clipo] Compacting database...');
        this._isCompacting = true;
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
             this._compact();
             this._isCompacting = false;
             return GLib.SOURCE_REMOVE;
        });
    }
    
    /**
     * Compact the log by rewriting only active entries
     */
    _compact() {
        let entries;
        try {
            entries = this._loadFromLogSync();
        } catch(e) {
            return;
        }
        
        // Write new compacted log
        const tempPath = GLib.build_filenamev([this._cacheDir, 'database.tmp']);
        const tempFile = Gio.File.new_for_path(tempPath);
        
        const stream = tempFile.replace(
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null
        );
        const bufferedStream = Gio.BufferedOutputStream.new(stream);
        const dataStream = Gio.DataOutputStream.new(bufferedStream);
        dataStream.set_byte_order(Gio.DataStreamByteOrder.LITTLE_ENDIAN);
        
        for (const entry of entries) {
            if (entry.type === 'text') {
                dataStream.put_byte(OP_TYPE_SAVE_TEXT, null);
                dataStream.put_uint32(entry.diskId, null);
                dataStream.put_int64(entry.timestamp, null);
                dataStream.put_byte(entry.pinned ? 1 : 0, null);
                
                const plainBytes = entry.plain ? new TextEncoder().encode(entry.plain) : new Uint8Array(0);
                dataStream.put_uint32(plainBytes.length, null);
                if (plainBytes.length > 0) {
                    dataStream.write_bytes(new GLib.Bytes(plainBytes), null);
                }
                
                const richBytes = entry.rich ? new TextEncoder().encode(entry.rich) : new Uint8Array(0);
                dataStream.put_uint32(richBytes.length, null);
                if (richBytes.length > 0) {
                    dataStream.write_bytes(new GLib.Bytes(richBytes), null);
                }
            } else if (entry.type === 'image' && entry._imagePath) {
                dataStream.put_byte(OP_TYPE_SAVE_IMAGE, null);
                dataStream.put_uint32(entry.diskId, null);
                dataStream.put_int64(entry.timestamp, null);
                dataStream.put_byte(entry.pinned ? 1 : 0, null);
                
                const pathBytes = new TextEncoder().encode(entry._imagePath);
                dataStream.put_uint32(pathBytes.length, null);
                dataStream.write_bytes(new GLib.Bytes(pathBytes), null);
            }
        }
        
        bufferedStream.flush(null);
        stream.close(null);
        
        // Replace old log with new one
        const dbFile = Gio.File.new_for_path(this._dbPath);
        try {
            tempFile.move(dbFile, Gio.FileCopyFlags.OVERWRITE, null, null);
            this._uselessOpCount = 0;
            console.log(`[Clipo] Compacted ${entries.length} entries`);
        } catch (e) {
            console.error('[Clipo] Failed to replace db during compact', e);
            try { tempFile.delete(null); } catch(ex){}
        }
    }
    
    /**
     * Clear all non-pinned entries from disk
     */
    clearNonPinned() {
        return this._queueOp(() => {
            const entries = this._loadFromLogSync();
            const pinned = entries.filter(e => e.pinned);
            
            // Delete image files for non-pinned entries
            for (const entry of entries) {
                if (!entry.pinned && entry._imagePath) {
                    try {
                        const imageFile = Gio.File.new_for_path(entry._imagePath);
                        imageFile.delete(null);
                    } catch (e) {
                        // Ignore
                    }
                }
            }
            
            // Rewrite log with only pinned entries
            const file = Gio.File.new_for_path(this._dbPath);
            const stream = file.replace(
                null,
                false,
                Gio.FileCreateFlags.NONE,
                null
            );
            const dataStream = Gio.DataOutputStream.new(stream);
            dataStream.set_byte_order(Gio.DataStreamByteOrder.LITTLE_ENDIAN);
            
            for (const entry of pinned) {
                if (entry.type === 'text') {
                    dataStream.put_byte(OP_TYPE_SAVE_TEXT, null);
                    dataStream.put_uint32(entry.diskId, null);
                    dataStream.put_int64(entry.timestamp, null);
                    dataStream.put_byte(1, null);
                    
                    const plainBytes = entry.plain ? new TextEncoder().encode(entry.plain) : new Uint8Array(0);
                    dataStream.put_uint32(plainBytes.length, null);
                    if (plainBytes.length > 0) {
                        dataStream.write_bytes(new GLib.Bytes(plainBytes), null);
                    }
                    
                    const richBytes = entry.rich ? new TextEncoder().encode(entry.rich) : new Uint8Array(0);
                    dataStream.put_uint32(richBytes.length, null);
                    if (richBytes.length > 0) {
                        dataStream.write_bytes(new GLib.Bytes(richBytes), null);
                    }
                } else if (entry.type === 'image' && entry._imagePath) {
                    dataStream.put_byte(OP_TYPE_SAVE_IMAGE, null);
                    dataStream.put_uint32(entry.diskId, null);
                    dataStream.put_int64(entry.timestamp, null);
                    dataStream.put_byte(1, null);
                    
                    const pathBytes = new TextEncoder().encode(entry._imagePath);
                    dataStream.put_uint32(pathBytes.length, null);
                    dataStream.write_bytes(new GLib.Bytes(pathBytes), null);
                }
            }
            
            stream.close(null);
            this._uselessOpCount = 0;
        });
    }
    
    /**
     * Get total cache size
     */
    getCacheSize() {
        let totalSize = 0;
        
        // Log file size
        const dbFile = Gio.File.new_for_path(this._dbPath);
        if (dbFile.query_exists(null)) {
            const info = dbFile.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
            totalSize += info.get_size();
        }
        
        // Image cache size
        const imageDir = Gio.File.new_for_path(this._imageCacheDir);
        if (imageDir.query_exists(null)) {
            const enumerator = imageDir.enumerate_children(
                'standard::size',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            
            let fileInfo;
            while ((fileInfo = enumerator.next_file(null)) !== null) {
                totalSize += fileInfo.get_size();
            }
        }
        
        return totalSize;
    }

    _clearPersistedData() {
        const dbFile = Gio.File.new_for_path(this._dbPath);
        if (dbFile.query_exists(null)) {
            try {
                dbFile.delete(null);
            } catch (_) {
                const stream = dbFile.replace(null, false, Gio.FileCreateFlags.NONE, null);
                stream.close(null);
            }
        }

        const imageDir = Gio.File.new_for_path(this._imageCacheDir);
        if (imageDir.query_exists(null)) {
            const enumerator = imageDir.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let fileInfo;
            while ((fileInfo = enumerator.next_file(null)) !== null) {
                try {
                    imageDir.get_child(fileInfo.get_name()).delete(null);
                } catch (_) {
                    // Ignore individual file deletion failures during cleanup.
                }
            }
        }

        this._uselessOpCount = 0;
    }

    _rewritePersistedEntries(entries) {
        this._ensureDirectories();

        const keepImagePaths = new Set();
        for (const entry of entries) {
            if (!entry.diskId) {
                entry.diskId = this.getNextDiskId();
            }

            if (entry.type === 'image' && entry._imagePath) {
                const existingImageFile = Gio.File.new_for_path(entry._imagePath);
                if (existingImageFile.query_exists(null)) {
                    keepImagePaths.add(entry._imagePath);
                }
            }

            if (entry.type === 'image' && entry.imageData) {
                if (!entry._imagePath) {
                    entry._imagePath = GLib.build_filenamev([
                        this._imageCacheDir,
                        `${entry.diskId}.png`,
                    ]);
                }

                const imageFile = Gio.File.new_for_path(entry._imagePath);
                const imageStream = imageFile.replace(
                    null,
                    false,
                    Gio.FileCreateFlags.NONE,
                    null
                );
                imageStream.write_bytes(toGLibBytes(entry.imageData), null);
                imageStream.close(null);
                keepImagePaths.add(entry._imagePath);
            }
        }

        const imageDir = Gio.File.new_for_path(this._imageCacheDir);
        if (imageDir.query_exists(null)) {
            const enumerator = imageDir.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let fileInfo;
            while ((fileInfo = enumerator.next_file(null)) !== null) {
                const file = imageDir.get_child(fileInfo.get_name());
                const path = file.get_path();
                if (path && !keepImagePaths.has(path)) {
                    try {
                        file.delete(null);
                    } catch (_) {
                        // Ignore cleanup failures and continue rewriting the database.
                    }
                }
            }
        }

        const file = Gio.File.new_for_path(this._dbPath);
        const stream = file.replace(
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null
        );
        const dataStream = Gio.DataOutputStream.new(stream);
        dataStream.set_byte_order(Gio.DataStreamByteOrder.LITTLE_ENDIAN);

        for (const entry of entries) {
            if (entry.type === 'text') {
                dataStream.put_byte(OP_TYPE_SAVE_TEXT, null);
                dataStream.put_uint32(entry.diskId, null);
                dataStream.put_int64(entry.timestamp, null);
                dataStream.put_byte(entry.pinned ? 1 : 0, null);

                const plainBytes = entry.plain ? new TextEncoder().encode(entry.plain) : new Uint8Array(0);
                dataStream.put_uint32(plainBytes.length, null);
                if (plainBytes.length > 0) {
                    dataStream.write_bytes(new GLib.Bytes(plainBytes), null);
                }

                const richBytes = entry.rich ? new TextEncoder().encode(entry.rich) : new Uint8Array(0);
                dataStream.put_uint32(richBytes.length, null);
                if (richBytes.length > 0) {
                    dataStream.write_bytes(new GLib.Bytes(richBytes), null);
                }
            } else if (entry.type === 'image' && entry._imagePath) {
                dataStream.put_byte(OP_TYPE_SAVE_IMAGE, null);
                dataStream.put_uint32(entry.diskId, null);
                dataStream.put_int64(entry.timestamp, null);
                dataStream.put_byte(entry.pinned ? 1 : 0, null);

                const pathBytes = new TextEncoder().encode(entry._imagePath);
                dataStream.put_uint32(pathBytes.length, null);
                dataStream.write_bytes(new GLib.Bytes(pathBytes), null);
            }
        }

        stream.close(null);
        this._uselessOpCount = 0;
    }
}

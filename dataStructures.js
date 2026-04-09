/**
 * Clipo - Data Structures
 * Optimized linked list and inverted index for clipboard entries
 */

export class ClipboardEntry {
    constructor(id, type, content) {
        this.id = id;
        this.diskId = null; // Set when persisted to disk
        this.type = type; // 'text' or 'image'
        this.timestamp = Date.now();
        this.pinned = false;
        
        // Content fields
        this.plain = null;
        this.rich = null;
        this.imageData = null;
        
        // Set content based on type
        if (type === 'text') {
            if (typeof content === 'object') {
                this.plain = content.plain || null;
                this.rich = content.rich || null;
            } else {
                this.plain = content;
            }
        } else if (type === 'image') {
            this.imageData = content;
        }
        
        // Linked list pointers
        this.next = null;
        this.prev = null;
        this.list = null;
        
        // UI reference
        this.menuItem = null;
    }
    
    /**
     * Get display text for this entry
     */
    getDisplayText() {
        if (this.type === 'text') {
            return this.plain || this.rich || '';
        }
        return '[Image]';
    }
    
    /**
     * Get byte size of this entry
     */
    getByteSize() {
        let size = 0;
        if (this.plain) size += this.plain.length * 2; // UTF-16
        if (this.rich) size += this.rich.length * 2;
        if (this.imageData) {
            size += this.imageData.get_size?.() ?? this.imageData.length ?? 0;
        }
        return size;
    }
    
    /**
     * Get content hash for deduplication
     */
    getHash() {
        if (this.type === 'text') {
            const text = this.plain || this.rich || '';
            // For long strings, use length as hash (fast, low collision)
            if (text.length > 500) {
                return text.length;
            }
            // For short strings, compute simple hash
            let hash = 0;
            for (let i = 0; i < text.length; i++) {
                hash = ((hash << 5) - hash) + text.charCodeAt(i);
                hash = hash & hash; // Convert to 32-bit integer
            }
            return hash;
        }
        // For images, use byte length
        if (!this.imageData)
            return 0;

        return this.imageData.get_size?.() ?? this.imageData.length ?? 0;
    }
    
    /**
     * Get next entry (cyclic)
     */
    nextCyclic() {
        if (!this.list) return null;
        return this.next || this.list.first;
    }
    
    /**
     * Get previous entry (cyclic)
     */
    prevCyclic() {
        if (!this.list) return null;
        return this.prev || this.list.last;
    }
}

export class LinkedList {
    constructor() {
        this.first = null;
        this.last = null;
        this.size = 0;
        this.byteSize = 0;
        
        // Inverted index for O(1) duplicate detection
        // hash -> entry
        this.index = new Map();
        
        // ID to entry map for O(1) lookup
        this.idMap = new Map();
    }
    
    /**
     * Add entry to beginning of list
     */
    prepend(entry) {
        entry.list = this;
        
        if (!this.first) {
            // Empty list
            this.first = entry;
            this.last = entry;
            entry.next = null;
            entry.prev = null;
        } else {
            // Insert at beginning
            entry.next = this.first;
            entry.prev = null;
            this.first.prev = entry;
            this.first = entry;
        }
        
        this.size++;
        this.byteSize += entry.getByteSize();
        
        // Update indices
        this.idMap.set(entry.id, entry);
        const hash = entry.getHash();
        this.index.set(hash, entry);
        
        return entry;
    }
    
    /**
     * Add entry to end of list
     */
    append(entry) {
        entry.list = this;
        
        if (!this.last) {
            // Empty list
            this.first = entry;
            this.last = entry;
            entry.next = null;
            entry.prev = null;
        } else {
            // Insert at end
            entry.prev = this.last;
            entry.next = null;
            this.last.next = entry;
            this.last = entry;
        }
        
        this.size++;
        this.byteSize += entry.getByteSize();
        
        // Update indices
        this.idMap.set(entry.id, entry);
        const hash = entry.getHash();
        this.index.set(hash, entry);
        
        return entry;
    }
    
    /**
     * Remove entry from list
     */
    remove(entry) {
        if (!entry.list || entry.list !== this) {
            return false;
        }
        
        // Update pointers
        if (entry.prev) {
            entry.prev.next = entry.next;
        } else {
            this.first = entry.next;
        }
        
        if (entry.next) {
            entry.next.prev = entry.prev;
        } else {
            this.last = entry.prev;
        }
        
        this.size--;
        this.byteSize -= entry.getByteSize();
        
        // Update indices
        this.idMap.delete(entry.id);
        const hash = entry.getHash();
        if (this.index.get(hash) === entry) {
            this.index.delete(hash);
        }
        
        entry.list = null;
        entry.next = null;
        entry.prev = null;
        
        return true;
    }
    
    /**
     * Move entry to beginning of list
     */
    moveToFront(entry) {
        if (entry.list !== this || entry === this.first) {
            return;
        }
        
        this.remove(entry);
        this.prepend(entry);
    }
    
    /**
     * Find duplicate entry by hash
     */
    findDuplicate(hash) {
        return this.index.get(hash) || null;
    }
    
    /**
     * Find entry by ID
     */
    findById(id) {
        return this.idMap.get(id) || null;
    }
    
    /**
     * Get all entries as array
     */
    toArray() {
        const result = [];
        let current = this.first;
        while (current) {
            result.push(current);
            current = current.next;
        }
        return result;
    }
    
    /**
     * Get entries matching filter
     */
    filter(predicate) {
        const result = [];
        let current = this.first;
        while (current) {
            if (predicate(current)) {
                result.push(current);
            }
            current = current.next;
        }
        return result;
    }
    
    /**
     * Clear all entries
     */
    clear() {
        let current = this.first;
        while (current) {
            const next = current.next;
            current.list = null;
            current.next = null;
            current.prev = null;
            current = next;
        }
        
        this.first = null;
        this.last = null;
        this.size = 0;
        this.byteSize = 0;
        this.index.clear();
        this.idMap.clear();
    }
}

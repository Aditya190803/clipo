/**
 * Clipo - Main Extension
 * Windows 11-style clipboard manager for GNOME Shell
 */

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ClipboardEntry, LinkedList } from './dataStructures.js';
import { Store } from './store.js';

// Constants
const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;
const GET_DEFAULT_CLIPBOARD = St.Clipboard.get_default.bind(St.Clipboard);
const MAX_PREVIEW_LENGTH = 150;
const MAX_IMAGE_PIXELS = 20 * 1000 * 1000;
const OCR_IMAGE_HOLD_MS = 2200;
const OCR_TEXT_MATCH_WINDOW_MS = 3000;
const OCR_MIN_TEXT_LENGTH = 8;
const MAX_REGEX_QUERY_LENGTH = 128;
const TEXT_EXTRACTOR_SCREENSHOT_DIR = GLib.build_filenamev([GLib.get_home_dir(), 'Pictures', 'Screenshots', 'TextExtractor']);
const POPUP_EDGE_MARGIN = 16;
const DEBUG_LOGGING_ENABLED = GLib.getenv('CLIPO_DEBUG') === '1';
const IMAGE_MIME_TYPES = [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif',
    'image/bmp',
    'image/tiff',
];

function logDebug(...args) {
    if (DEBUG_LOGGING_ENABLED)
        console.log(...args);
}

function logWarn(...args) {
    // Warnings always surface; debug gate only suppresses verbose info logs
    console.warn('[Clipo]', ...args);
}

function logError(...args) {
    // Errors always surface so real problems are visible in journalctl
    console.error('[Clipo]', ...args);
}

function isActorDestroyed(actor) {
    if (!actor)
        return true;

    try {
        if (typeof actor.is_destroyed === 'function')
            return actor.is_destroyed();
        if ('destroyed' in actor)
            return Boolean(actor.destroyed);
    } catch (_) {
        return true;
    }

    return false;
}

/**
 * Format a timestamp as a relative time string
 */
function formatRelativeTime(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) {
        return _('Just now');
    } else if (minutes < 60) {
        return minutes === 1 ? _('1 min ago') : _('%d mins ago').format(minutes);
    } else if (hours < 24) {
        return hours === 1 ? _('1 hour ago') : _('%d hours ago').format(hours);
    } else if (days === 1) {
        return _('Yesterday');
    } else if (days < 7) {
        return _('%d days ago').format(days);
    } else {
        // Format as date
        const date = new Date(timestamp);
        return date.toLocaleDateString();
    }
}

function toGBytes(data) {
    if (!data)
        return null;

    if (data instanceof GLib.Bytes)
        return data;

    if (data instanceof Uint8Array)
        return new GLib.Bytes(data);

    if (Array.isArray(data))
        return new GLib.Bytes(Uint8Array.from(data));

    if (typeof data.toArray === 'function')
        return new GLib.Bytes(Uint8Array.from(data.toArray()));

    return new GLib.Bytes(data);
}

function getByteLength(data) {
    if (!data)
        return 0;

    if (data instanceof GLib.Bytes)
        return data.get_size();

    return data.length ?? 0;
}

function bytesEqual(left, right) {
    const leftLength = getByteLength(left);
    const rightLength = getByteLength(right);

    if (leftLength !== rightLength)
        return false;

    if (leftLength === 0)
        return true;

    // Fast path: if both are GLib.Bytes, use the native C-level comparison
    // which avoids creating any JS-side array copies (prevents OOM on large images).
    if (left instanceof GLib.Bytes && right instanceof GLib.Bytes) {
        if (typeof left.equal === 'function') {
            return left.equal(right);
        }
        // Fallback: compare via native get_data() which returns the same
        // backing buffer without a full copy when possible.
    }

    // For large images (>256 KB) do a fast sampled comparison to avoid
    // blocking the GNOME Shell main loop with a full byte-by-byte scan.
    // We check the first 512 bytes, last 512 bytes, and 16 evenly-spaced
    // samples across the middle — enough to detect any real difference.
    const SAMPLE_THRESHOLD = 256 * 1024;

    // Only convert to arrays when absolutely necessary, and only for
    // small data. For large data, we sample from get_data() instead.
    let leftBytes, rightBytes;
    if (leftLength > SAMPLE_THRESHOLD) {
        // Use get_data() which may share the backing buffer without a full copy
        leftBytes = left instanceof GLib.Bytes ? left.get_data() : left;
        rightBytes = right instanceof GLib.Bytes ? right.get_data() : right;

        if (!leftBytes || !rightBytes)
            return false;

        const EDGE = 512;
        const SAMPLES = 16;
        // Check head
        for (let i = 0; i < Math.min(EDGE, leftLength); i++) {
            if (leftBytes[i] !== rightBytes[i]) return false;
        }
        // Check tail
        for (let i = leftLength - Math.min(EDGE, leftLength); i < leftLength; i++) {
            if (leftBytes[i] !== rightBytes[i]) return false;
        }
        // Check evenly-spaced samples in middle
        const step = Math.floor(leftLength / (SAMPLES + 1));
        for (let s = 1; s <= SAMPLES; s++) {
            const i = s * step;
            if (leftBytes[i] !== rightBytes[i]) return false;
        }
        return true;
    }

    leftBytes = left instanceof GLib.Bytes ? left.toArray() : left;
    rightBytes = right instanceof GLib.Bytes ? right.toArray() : right;

    for (let i = 0; i < leftLength; i++) {
        if (leftBytes[i] !== rightBytes[i])
            return false;
    }

    return true;
}

function readUint16BE(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32BE(bytes, offset) {
    return (
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]
    ) >>> 0;
}

function readUint32LE(bytes, offset) {
    return (
        bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)
    ) >>> 0;
}

function getImageDimensions(data) {
    const bytes = data instanceof GLib.Bytes ? data.get_data() : data;
    if (!bytes || bytes.length < 10)
        return null;

    try {
        // PNG IHDR
        if (bytes.length >= 24 &&
            bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
            bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) {
            return {
                width: readUint32BE(bytes, 16),
                height: readUint32BE(bytes, 20),
            };
        }

        // JPEG SOF markers
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
            let offset = 2;
            while (offset + 9 < bytes.length) {
                if (bytes[offset] !== 0xFF) {
                    offset++;
                    continue;
                }

                const marker = bytes[offset + 1];
                if (marker === 0xD9 || marker === 0xDA)
                    break;

                const segmentLength = readUint16BE(bytes, offset + 2);
                if (segmentLength < 2)
                    break;

                if ((marker >= 0xC0 && marker <= 0xC3) ||
                    (marker >= 0xC5 && marker <= 0xC7) ||
                    (marker >= 0xC9 && marker <= 0xCB) ||
                    (marker >= 0xCD && marker <= 0xCF)) {
                    return {
                        width: readUint16BE(bytes, offset + 7),
                        height: readUint16BE(bytes, offset + 5),
                    };
                }

                offset += 2 + segmentLength;
            }
        }

        // GIF logical screen descriptor
        if (bytes.length >= 10 &&
            bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
            return {
                width: bytes[6] | (bytes[7] << 8),
                height: bytes[8] | (bytes[9] << 8),
            };
        }

        // BMP DIB header
        if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4D) {
            return {
                width: readUint32LE(bytes, 18),
                height: Math.abs(readUint32LE(bytes, 22)),
            };
        }
    } catch (_) {
        return null;
    }

    return null;
}

function isOversizedImage(data) {
    const dimensions = getImageDimensions(data);
    if (!dimensions)
        return false;

    const { width, height } = dimensions;
    if (!width || !height)
        return false;

    return width * height > MAX_IMAGE_PIXELS;
}

// Sensitive content patterns
// API key / credential patterns — blocked when 'ignore-api-keys' is on
const API_KEY_PATTERNS = [
    /^.{0,20}password.{0,5}[:=].+/i,
    /^.{0,20}passwd.{0,5}[:=].+/i,
    /^.{0,20}pwd.{0,5}[:=].+/i,
    /^.{0,20}secret.{0,5}[:=].+/i,
    /^[a-z0-9_-]*api[_-]?key[a-z0-9_-]*[:=]\s*.+/i,
    /^[a-z0-9_-]*token[:=]\s*.+/i,
    /^bearer\s+[a-zA-Z0-9_-]+/i,
    /AKIA[0-9A-Z]{16}/,
    /aws[_-]?(access|secret)[_-]?key/i,
    /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
    /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----/,
    /-----BEGIN\s+PGP\s+PRIVATE\s+KEY-----/,
    /^[a-z0-9_-]*(secret|credential|auth)[_-]?[a-z0-9_-]*[:=]\s*.+/i,
    /gh[pousr]_[A-Za-z0-9_]{36,}/,
    /glpat-[A-Za-z0-9_-]{20,}/,
    /^[a-f0-9]{40,}$/i,
    /ssh-rsa\s+AAAA[0-9A-Za-z+/]+/,
    /ssh-ed25519\s+AAAA[0-9A-Za-z+/]+/,
    // OpenAI / Anthropic / generic prefixed keys
    /^sk-[A-Za-z0-9_-]{20,}/,
    /^sk-proj-[A-Za-z0-9_-]{20,}/,
    /^xai-[A-Za-z0-9_-]{20,}/,
];

// Credit / debit card patterns — blocked when 'ignore-credit-cards' is on
const CREDIT_CARD_PATTERNS = [
    // Visa, Mastercard, Amex, Discover — 13–19 digits, optional spaces/dashes
    /\b(?:4[0-9]{12}(?:[0-9]{3,6})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12,15}|(?:2131|1800|35\d{3})\d{11})\b/,
];

/**
 * Clipboard Item UI Component - Windows 11 style card
 */
const ClipboardItem = GObject.registerClass(
    class ClipboardItem extends St.BoxLayout {
        _init(entry, indicator) {
            super._init({
                style_class: 'clipo-item',
                vertical: false,
                reactive: true,
                can_focus: true,
                track_hover: true,
                x_expand: true,
                clip_to_allocation: true,
            });

            this.entry = entry;
            this._indicator = indicator;
            this._signalHandlers = [];
            entry.menuItem = this;

            this._buildContent();
            this._connectSignals();
        }

        _buildContent() {
            // Outer container: content on left, actions pinned to right
            const mainBox = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style_class: 'clipo-item-main',
            });

            // Left side: content preview — always x_expand so actions are pushed right
            this._contentBox = new St.BoxLayout({
                style_class: 'clipo-item-content',
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                clip_to_allocation: true,
            });
            mainBox.add_child(this._contentBox);

            if (this.entry.type === 'image') {
                this._buildImagePreview();
            } else {
                this._buildTextPreview();
            }

            // Right side: Actions column — fixed width, always anchored to right
            this._actionsBox = new St.BoxLayout({
                vertical: true,
                style_class: 'clipo-item-actions',
                x_expand: false,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: false,
            });

            this._deleteButton = new St.Button({
                style_class: 'clipo-delete-button',
                child: new St.Icon({
                    icon_name: 'window-close-symbolic',
                    icon_size: 16,
                }),
                can_focus: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._wireActionButton(this._deleteButton, this._onDeleteClicked.bind(this));
            this._actionsBox.add_child(this._deleteButton);

            this._pinButton = new St.Button({
                style_class: this.entry.pinned ? 'clipo-pin-button clipo-pinned' : 'clipo-pin-button',
                child: new St.Icon({
                    icon_name: 'view-pin-symbolic',
                    icon_size: 16,
                }),
                can_focus: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._wireActionButton(this._pinButton, this._onPinClicked.bind(this));
            this._actionsBox.add_child(this._pinButton);

            mainBox.add_child(this._actionsBox);
            this.add_child(mainBox);
        }

        _buildTextPreview() {
            const text = this.entry.getDisplayText();
            const preview = this._formatPreview(text);

            this._label = new St.Label({
                text: preview,
                style_class: 'clipo-item-text',
                x_expand: true,
            });
            const labelText = this._label.clutter_text;
            labelText.ellipsize = 3; // PANGO_ELLIPSIZE_END
            labelText.line_wrap = true;
            labelText.line_wrap_mode = 2; // PANGO_WRAP_WORD_CHAR
            if (typeof labelText.set_single_line_mode === 'function') {
                labelText.set_single_line_mode(false);
            } else if ('single_line_mode' in labelText) {
                labelText.single_line_mode = false;
            }

            const maxLines = this._indicator ? this._indicator._settings.get_int('preview-lines') : 2;
            if (typeof labelText.set_max_lines === 'function') {
                labelText.set_max_lines(maxLines);
            } else if ('max_lines' in labelText) {
                labelText.max_lines = maxLines;
            }
            this._contentBox.add_child(this._label);

            // Timestamp — always present, shown via CSS opacity on hover
            if (this.entry.timestamp) {
                this._timestampLabel = new St.Label({
                    text: formatRelativeTime(this.entry.timestamp),
                    style_class: 'clipo-item-timestamp',
                });
                this._contentBox.add_child(this._timestampLabel);
            }
        }

        _buildImagePreview() {
            this._addImageFallback();
        }

        _addImageFallback() {
            const fallbackBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'clipo-image-fallback-box',
            });

            fallbackBox.add_child(new St.Icon({
                icon_name: 'image-x-generic-symbolic',
                icon_size: 48,
                style_class: 'clipo-image-fallback',
            }));

            this._contentBox.add_child(fallbackBox);
            this._contentBox.add_child(this._buildImageMeta());
        }

        _buildImageMeta(cachedPixbuf = null) {
            let dimensions = '';
            let sizeText = '';

            try {
                const parsedDimensions = this.entry.imageDimensions
                    || (this.entry.imageData ? getImageDimensions(this.entry.imageData) : null);
                if (parsedDimensions) {
                    dimensions = `${parsedDimensions.width}×${parsedDimensions.height}`;
                } else if (cachedPixbuf) {
                    const pixbuf = cachedPixbuf;
                    dimensions = `${pixbuf.get_width()}×${pixbuf.get_height()}`;
                }
            } catch (_) {
                dimensions = '';
            }

            const bytes = getByteLength(this.entry.imageData);
            if (bytes > 0)
                sizeText = `${Math.max(1, Math.round(bytes / 1024))} KB`;

            const mimeText = this.entry.imageMimeType || '';
            const meta = [dimensions, sizeText, mimeText].filter(Boolean).join('  •  ');

            const infoBox = new St.BoxLayout({
                vertical: true,
                style_class: 'clipo-image-info',
                x_expand: true,
            });

            infoBox.add_child(new St.Label({
                text: _('Image'),
                style_class: 'clipo-image-label',
                x_expand: true,
            }));

            if (meta) {
                infoBox.add_child(new St.Label({
                    text: meta,
                    style_class: 'clipo-image-meta',
                    x_expand: true,
                }));
            }

            return infoBox;
        }

        _hideImagePreview() {
            this._previewPopup = null;
        }

        _formatPreview(text) {
            let preview = text.replace(/\s+/g, ' ').trim();
            if (preview.length > MAX_PREVIEW_LENGTH) {
                preview = preview.substring(0, MAX_PREVIEW_LENGTH) + '…';
            }
            return preview || _('Empty text');
        }

        _wireActionButton(button, handler) {
            this._connectTrackedSignal(button, 'button-press-event', (actor, event) => {
                if (event.get_button() === 1) {
                    handler();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this._connectTrackedSignal(button, 'button-release-event', () => Clutter.EVENT_STOP);
        }

        _connectTrackedSignal(actor, signal, handler) {
            if (!actor || typeof actor.connect !== 'function')
                return 0;

            const id = actor.connect(signal, handler);
            this._signalHandlers.push([actor, id]);
            return id;
        }

        _disconnectTrackedSignals() {
            for (const [actor, id] of this._signalHandlers) {
                try {
                    if (actor && id)
                        actor.disconnect(id);
                } catch (_) { }
            }
            this._signalHandlers = [];
        }

        _isAlive() {
            if (isActorDestroyed(this))
                return false;

            const indicator = this._indicator;
            if (!indicator)
                return false;

            if (typeof indicator._isAlive === 'function')
                return indicator._isAlive();

            return !indicator._isDestroying && !indicator._isDestroyed;
        }

        _connectSignals() {
            this.connect('key-focus-in', () => {
                this._indicator?._queueEnsureActorVisible(this);
            });

            // Single key-press-event handler that covers both navigation and activation.
            // Previously there were TWO separate key-press-event connections here which
            // caused the second one to be untracked and leaked, and could fire twice.
            this.connect('key-press-event', (actor, event) => {
                const key = event.get_key_symbol();
                if (key === Clutter.KEY_Down) {
                    const next = this._indicator?._findFocusableSibling(this, 1);
                    if (next) {
                        next.grab_key_focus();
                        this._indicator?._queueEnsureActorVisible(next);
                        return Clutter.EVENT_STOP;
                    }
                } else if (key === Clutter.KEY_Up) {
                    const prev = this._indicator?._findFocusableSibling(this, -1);
                    if (prev) {
                        prev.grab_key_focus();
                        this._indicator?._queueEnsureActorVisible(prev);
                        return Clutter.EVENT_STOP;
                    } else if (this._indicator && this._indicator._searchEntry) {
                        this._indicator._searchEntry.grab_key_focus();
                        return Clutter.EVENT_STOP;
                    }
                } else if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
                    this._indicator._selectEntry(this.entry);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this.connect('button-press-event', (actor, event) => {
                if (event.get_button() === 1) { // Left click
                    this._indicator._selectEntry(this.entry);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }

        highlightSearch(searchQuery) {
            if (!this._label || this.entry.type !== 'text') return;

            const text = this.entry.getDisplayText();
            const preview = this._formatPreview(text);

            if (!searchQuery || searchQuery.length === 0) {
                this._label.text = preview;
                return;
            }

            const regex = this._indicator?._buildSearchRegex(searchQuery) || null;
            let idx = -1;
            let matchLength = searchQuery.length;

            if (regex) {
                const match = preview.match(regex);
                if (match && typeof match.index === 'number') {
                    idx = match.index;
                    matchLength = match[0].length;
                }
            } else {
                const lowerPreview = preview.toLowerCase();
                const lowerSearch = searchQuery.toLowerCase();
                idx = lowerPreview.indexOf(lowerSearch);
            }

            if (idx >= 0) {
                const before = GLib.markup_escape_text(preview.substring(0, idx), -1);
                const match = GLib.markup_escape_text(preview.substring(idx, idx + matchLength), -1);
                const after = GLib.markup_escape_text(preview.substring(idx + matchLength), -1);

                const markup = `${before}<span background="#0a84ff44">${match}</span>${after}`;
                this._label.clutter_text.set_markup(markup);
            } else {
                this._label.clutter_text.set_markup(GLib.markup_escape_text(preview, -1));
            }
        }

        _onPinClicked() {
            this._indicator._togglePin(this.entry);
            return Clutter.EVENT_STOP;
        }

        _onDeleteClicked() {
            this._indicator._deleteEntry(this.entry);
            return Clutter.EVENT_STOP;
        }

        setSelected(selected) {
            if (selected) {
                this.add_style_class_name('clipo-item-selected');
            } else {
                this.remove_style_class_name('clipo-item-selected');
            }
        }

        updatePinState() {
            if (this.entry.pinned) {
                this._pinButton.add_style_class_name('clipo-pinned');
                this.add_style_class_name('clipo-pinned-item');
            } else {
                this._pinButton.remove_style_class_name('clipo-pinned');
                this.remove_style_class_name('clipo-pinned-item');
            }
        }

        destroy() {
            this._hideImagePreview();
            this._disconnectTrackedSignals();
            if (this.entry)
                this.entry.menuItem = null;
            super.destroy();
        }
    });

/**
 * Main Clipboard Indicator - Windows 11 style
 */
const ClipboardIndicator = GObject.registerClass(
    class ClipboardIndicator extends PanelMenu.Button {
        _init(extension) {
            super._init(0.0, 'Clipo');

            this._extension = extension;
            this._settings = extension.getSettings();
            this._store = new Store(this._settings);

            // Data structures
            this._history = new LinkedList();
            this._pinned = new LinkedList();
            this._searchResults = null;
            this._searchQuery = '';
            this._selectedEntry = null;
            this._menuNeedsRefresh = false;
            this._menuIsOpen = false;
            this._debouncing = 0;
            this._privateMode = this._settings.get_boolean('private-mode');
            this._clipboardChangeTimeout = null;
            this._pendingImageCapture = null;
            this._pendingImageTimeout = null;
            this._lastImageTimestamp = 0;
            this._focusTimeout = null;
            this._signalHandlers = [];
            this._sourceIds = new Set();
            this._menuRepositionIdleId = null;
            this._menuScrollResetIdleId = null;
            this._ensureVisibleIdleId = null;
            this._pasteTimeoutId = null;
            this._animTimeouts = [];
            this._isDestroying = false;
            this._isDestroyed = false;

            this._lastTextExtractorFileMs = 0;
            this._textExtractorMonitor = null;
            this._textExtractorMonitorChangedId = 0;

            // Cursor position captured at toggle time
            this._savedCursorX = 0;
            this._savedCursorY = 0;

            // Build UI
            this._buildIndicator();
            this._buildMenu();

            // Initialize
            this._initClipboard();
            this._bindSettings();
            this._registerKeybindings();
            this._startTextExtractorMonitor();
        }

        _buildIndicator() {
            this._box = new St.BoxLayout({
                style_class: 'panel-status-menu-box',
            });

            this._indicatorIcon = new St.Icon({
                icon_name: 'edit-paste-symbolic',
                style_class: 'system-status-icon',
            });

            this._indicatorLabel = new St.Label({
                text: 'Clipo',
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._box.add_child(this._indicatorIcon);
            this._box.add_child(this._indicatorLabel);

            this.add_child(this._box);

            // Capture pointer only for direct clicks on this panel button.
            this._connectTrackedSignal(this, 'button-press-event', () => {
                const [pointerX, pointerY] = global.get_pointer();
                this._savedCursorX = pointerX;
                this._savedCursorY = pointerY;
                return Clutter.EVENT_PROPAGATE;
            });

            this._updateIndicatorDisplay();
        }

        _updateIndicatorDisplay() {
            if (!this._box) return;
            const mode = this._settings.get_string('top-bar-display') || 'icon';
            this._indicatorIcon.visible = (mode === 'icon' || mode === 'both');
            this._indicatorLabel.visible = (mode === 'text' || mode === 'both');
            this.visible = (mode !== 'none');
        }

        _isAlive() {
            return !this._isDestroying && !this._isDestroyed;
        }

        _overrideMenuPositioning() {
            // Connect to open-state-changed to position AFTER menu opens
            this._connectTrackedSignal(this.menu, 'open-state-changed', (menu, isOpen) => {
                if (isOpen && this._settings.get_string('popup-position') === 'cursor') {
                    if (this._menuRepositionIdleId) {
                        GLib.source_remove(this._menuRepositionIdleId);
                        this._sourceIds.delete(this._menuRepositionIdleId);
                        this._menuRepositionIdleId = null;
                    }

                    // Use idle_add to ensure we run after BoxPointer's positioning
                    let sourceId = 0;
                    sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this._sourceIds.delete(sourceId);
                        if (this._menuRepositionIdleId === sourceId)
                            this._menuRepositionIdleId = null;

                        this._repositionAtCursor();
                        return GLib.SOURCE_REMOVE;
                    });

                    this._menuRepositionIdleId = sourceId;
                    this._sourceIds.add(sourceId);
                }
            });
        }

        _repositionAtCursor() {
            if (!this._isAlive())
                return;

            const pointerX = this._savedCursorX;
            const pointerY = this._savedCursorY;

            const monitor = this._getMonitorForPoint(pointerX, pointerY);
            if (!monitor) return;

            const boxPointer = this.menu?._boxPointer;
            const menuActor = boxPointer?.actor || this.menu?.actor;

            if (!menuActor || isActorDestroyed(menuActor))
                return;

            const configuredWidth = this._settings.get_int('window-width') || 400;
            const configuredHeight = this._settings.get_int('window-height') || 500;
            const [measuredWidth, measuredHeight] = typeof menuActor.get_transformed_size === 'function'
                ? menuActor.get_transformed_size()
                : [0, 0];
            const menuWidth = Math.max(1, Math.round(measuredWidth || menuActor.width || configuredWidth));
            const menuHeight = Math.max(1, Math.round(measuredHeight || menuActor.height || configuredHeight));

            let x = Math.floor(pointerX);
            let y = Math.floor(pointerY);

            const minX = monitor.x + POPUP_EDGE_MARGIN;
            const minY = monitor.y + POPUP_EDGE_MARGIN;
            const maxX = monitor.x + monitor.width - menuWidth - POPUP_EDGE_MARGIN;
            const maxY = monitor.y + monitor.height - menuHeight - POPUP_EDGE_MARGIN;

            x = Math.max(minX, Math.min(x, Math.max(minX, maxX)));
            y = Math.max(minY, Math.min(y, Math.max(minY, maxY)));

            try {
                if (!this._isAlive()) return;
                menuActor.set_position(x, y);
            } catch (_) {
                return;
            }

            if (boxPointer && !isActorDestroyed(boxPointer)) {
                if (boxPointer._border) {
                    try { boxPointer._border.hide(); } catch (_) { }
                }
                if (boxPointer._arrow) {
                    try { boxPointer._arrow.hide(); } catch (_) { }
                }
            }
        }

        _getMonitorForPoint(x, y) {
            const monitors = Main.layoutManager.monitors || [];

            for (const monitor of monitors) {
                if (x >= monitor.x && x < monitor.x + monitor.width &&
                    y >= monitor.y && y < monitor.y + monitor.height)
                    return monitor;
            }

            return Main.layoutManager.currentMonitor || monitors[0] || null;
        }

        _buildMenu() {
            // Override menu positioning for cursor mode
            this._overrideMenuPositioning();

            this.menu.actor.add_style_class_name('clipo-popup-menu');
            this.menu.actor.style = `width: ${this._settings.get_int('window-width') || 400}px`;

            // Header bar with label and actions
            const headerItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'clipo-header',
            });

            const headerBox = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style_class: 'clipo-header-box',
            });

            // Title label
            const titleRow = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style: 'spacing: 8px;',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._titleLabel = new St.Label({
                text: _('Clipo'),
                style_class: 'clipo-header-title',
                y_align: Clutter.ActorAlign.CENTER,
            });
            titleRow.add_child(this._titleLabel);

            // Item count badge
            this._countBadge = new St.Label({
                text: '',
                style_class: 'clipo-count-badge',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            titleRow.add_child(this._countBadge);
            headerBox.add_child(titleRow);

            // Clear all button
            this._clearButton = new St.Button({
                style_class: 'clipo-clear-button',
                child: new St.Label({
                    text: _('Clear all'),
                    style_class: 'clipo-clear-label',
                }),
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._clearButton.connect('clicked', () => this._clearHistory());
            headerBox.add_child(this._clearButton);

            headerItem.add_child(headerBox);
            this.menu.addMenuItem(headerItem);

            // Search row
            const searchItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'clipo-search-container',
            });

            this._searchEntry = new St.Entry({
                style_class: 'clipo-search-entry',
                hint_text: _('Search clipboard...'),
                track_hover: true,
                can_focus: true,
                x_expand: true,
            });

            this._searchEntry.set_primary_icon(new St.Icon({
                icon_name: 'system-search-symbolic',
                style_class: 'clipo-search-icon',
            }));

            this._searchEntry.clutter_text.connect('text-changed', () => this._onSearchChanged());
            this._searchEntry.clutter_text.connect('key-press-event', (actor, event) => {
                const symbol = event.get_key_symbol();

                if (symbol === Clutter.KEY_Down) {
                    const firstItem = this._getFirstFocusableItem();
                    if (firstItem) {
                        firstItem.grab_key_focus();
                        this._queueEnsureActorVisible(firstItem);
                        return Clutter.EVENT_STOP;
                    }
                }

                if (symbol === Clutter.KEY_Escape) {
                    const currentText = this._searchEntry.get_text();
                    if (currentText && currentText.length > 0) {
                        this._searchEntry.set_text('');
                        return Clutter.EVENT_STOP;
                    }
                }

                return Clutter.EVENT_PROPAGATE;
            });

            searchItem.add_child(this._searchEntry);
            this.menu.addMenuItem(searchItem);

            // Main scroll area - single list for all items
            const scrollItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'clipo-scroll-container',
            });

            this._scrollView = new St.ScrollView({
                style_class: 'clipo-scroll-view',
                overlay_scrollbars: true,
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
            });
            this._scrollView.style = `height: ${this._settings.get_int('window-height') || 500}px`;

            this._itemsBox = new St.BoxLayout({
                vertical: true,
                style_class: 'clipo-items-box',
            });
            this._scrollView.add_child(this._itemsBox);

            scrollItem.add_child(this._scrollView);
            this.menu.addMenuItem(scrollItem);

            // Footer with settings
            const footerItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'clipo-footer',
            });

            const footerBox = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style_class: 'clipo-footer-box',
            });

            // Private mode toggle
            this._privateButton = new St.Button({
                style_class: this._privateMode ? 'clipo-footer-btn clipo-private-active' : 'clipo-footer-btn',
                child: new St.Icon({
                    icon_name: 'security-high-symbolic',
                    icon_size: 16,
                }),
                can_focus: true,
            });
            this._privateButton.connect('clicked', () => this._togglePrivateMode());
            if (typeof this._privateButton.set_accessible_name === 'function')
                this._privateButton.set_accessible_name(_('Toggle private mode'));
            else
                this._privateButton.accessible_name = _('Toggle private mode');
            footerBox.add_child(this._privateButton);

            // Spacer
            footerBox.add_child(new St.Widget({ x_expand: true }));

            // Settings button
            this._settingsButton = new St.Button({
                style_class: 'clipo-footer-btn',
                child: new St.Icon({
                    icon_name: 'emblem-system-symbolic',
                    icon_size: 16,
                }),
                can_focus: true,
            });
            this._settingsButton.connect('clicked', () => this._openSettings());
            footerBox.add_child(this._settingsButton);

            footerItem.add_child(footerBox);
            this.menu.addMenuItem(footerItem);

            // Menu events
            this._connectTrackedSignal(this.menu, 'open-state-changed', (menu, open) => {
                this._menuIsOpen = open;
                if (open) {
                    this._onMenuOpened();
                } else {
                    if (this._itemsBox) {
                        for (const item of this._itemsBox.get_children()) {
                            if (typeof item._hideImagePreview === 'function') {
                                item._hideImagePreview();
                            }
                        }
                    }
                }
            });

            this._connectTrackedSignal(this.menu.actor, 'key-press-event', (actor, event) => {
                const symbol = event.get_key_symbol();
                const state = event.get_state();
                const searchFocused = global.stage.get_key_focus() === this._searchEntry?.clutter_text;

                // Type-ahead focus: typing anywhere in the popup moves focus to search.
                const hasModifiers = (state & (
                    Clutter.ModifierType.CONTROL_MASK |
                    Clutter.ModifierType.MOD1_MASK |
                    Clutter.ModifierType.SUPER_MASK
                )) !== 0;

                if (!searchFocused && this._searchEntry && !hasModifiers) {
                    const unicode = Clutter.keysym_to_unicode(symbol);
                    const isPrintable = unicode >= 0x20 && unicode !== 0x7F;

                    if (isPrintable) {
                        const character = String.fromCodePoint(unicode);
                        this._searchEntry.grab_key_focus();
                        this._searchEntry.set_text(this._searchEntry.get_text() + character);
                        this._searchEntry.clutter_text.set_cursor_position(-1);
                        return Clutter.EVENT_STOP;
                    }
                }

                if (symbol === Clutter.KEY_slash) {
                    if (!searchFocused && this._searchEntry) {
                        this._searchEntry.grab_key_focus();
                        return Clutter.EVENT_STOP;
                    }
                }

                if (symbol === Clutter.KEY_Escape) {
                    this.menu.close();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }

        _initClipboard() {
            const { history, pinned } = this._store.init();
            this._history = history;
            this._pinned = pinned;

            // Clipboard access is centralized here for reviewer visibility and auditing.
            this._clipboard = GET_DEFAULT_CLIPBOARD();
            this._selection = Shell.Global.get().get_display().get_selection();

            this._ownerChangedId = this._selection.connect('owner-changed',
                (selection, selectionType) => {
                    if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
                        this._onClipboardChanged();
                    }
                });

            this._pruneHistory();
            this._store.syncFromLists(this._history.toArray(), this._pinned.toArray());
            this._refreshMenu();
        }

        _bindSettings() {
            this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
                switch (key) {
                    case 'private-mode':
                        this._privateMode = settings.get_boolean('private-mode');
                        this._updatePrivateButton();
                        break;
                    case 'top-bar-display':
                        this._updateIndicatorDisplay();
                        break;
                    case 'window-width':
                        this.menu.actor.style = `width: ${settings.get_int('window-width')}px`;
                        break;
                    case 'window-height':
                        if (this._scrollView)
                            this._scrollView.style = `height: ${settings.get_int('window-height')}px`;
                        break;
                    case 'history-size':
                    case 'cache-size':
                        this._pruneHistory();
                        this._refreshMenu();
                        break;
                    case 'persist-history':
                    case 'save-only-pinned':
                        this._store.syncFromLists(this._history.toArray(), this._pinned.toArray());
                        break;
                    case 'preview-lines':
                    case 'show-thumbnails':
                        this._refreshMenu();
                        break;
                }
            });
        }

        _registerKeybindings() {
            Main.wm.addKeybinding(
                'toggle-menu',
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => {
                    // Capture cursor position BEFORE menu opens
                    const [pointerX, pointerY] = global.get_pointer();
                    this._savedCursorX = pointerX;
                    this._savedCursorY = pointerY;
                    this.menu.toggle();
                }
            );

            Main.wm.addKeybinding(
                'clear-history',
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._clearHistory()
            );

            Main.wm.addKeybinding(
                'toggle-private',
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._togglePrivateMode()
            );
        }

        _unregisterKeybindings() {
            Main.wm.removeKeybinding('toggle-menu');
            Main.wm.removeKeybinding('clear-history');
            Main.wm.removeKeybinding('toggle-private');
        }

        _onClipboardChanged() {
            if (!this._isAlive()) return;
            if (this._privateMode) return;

            if (this._debouncing > 0) {
                this._debouncing--;
                return;
            }

            // Add a small delay to coalesce rapid clipboard changes (e.g., from screenshot tools)
            if (this._clipboardChangeTimeout) {
                GLib.source_remove(this._clipboardChangeTimeout);
                this._sourceIds.delete(this._clipboardChangeTimeout);
                this._clipboardChangeTimeout = null;
            }

            let sourceId = 0;
            sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._sourceIds.delete(sourceId);
                this._clipboardChangeTimeout = null;
                this._queryClipboard();
                return GLib.SOURCE_REMOVE;
            });
            this._clipboardChangeTimeout = sourceId;
            this._sourceIds.add(sourceId);
        }

        _queryClipboard() {
            if (!this._isAlive())
                return;

            this._queryTextClipboard(() => {
                if (this._settings.get_boolean('enable-images'))
                    this._queryImageClipboard();
            });
        }

        _queryImageClipboard(mimeTypes = IMAGE_MIME_TYPES, index = 0) {
            if (!this._isAlive())
                return;

            if (index >= mimeTypes.length) {
                return;
            }

            const mimeType = mimeTypes[index];
            const self = this;
            const stableIndex = index;
            const stableMimeTypes = mimeTypes;

            this._clipboard.get_content(
                CLIPBOARD_TYPE,
                mimeType,
                (clipboard, bytes) => {
                    if (!self || self._isDestroying || self._isDestroyed) return;

                    if (!self._isAlive()) return;
                    if (!self._settings) return;

                    if (bytes && bytes.get_size() > 0) {
                        const imageData = toGBytes(bytes);
                        if (self._settings.get_boolean('has-text-extractor-extension')) {
                            self._schedulePendingImageCapture(imageData, mimeType);
                        } else {
                            self._processImageContent(imageData, mimeType);
                        }
                    } else {
                        self._queryImageClipboard(stableMimeTypes, stableIndex + 1);
                    }
                }
            );
        }

        _queryTextClipboard(onEmpty = null) {
            if (!this._isAlive())
                return;

            const preserveFormatting = this._settings.get_boolean('preserve-formatting');
            const self = this;

            if (preserveFormatting) {
                this._clipboard.get_content(
                    CLIPBOARD_TYPE,
                    'text/html',
                    (clipboard, bytes) => {
                        if (!self || self._isDestroying || self._isDestroyed) return;
                        if (!self._isAlive()) return;

                        if (!self._settings) return;

                        const richText = bytes && bytes.get_size() > 0
                            ? new TextDecoder().decode(bytes.get_data())
                            : null;

                        self._clipboard.get_text(CLIPBOARD_TYPE, (clipboard, text) => {
                            if (!self || self._isDestroying || self._isDestroyed) return;
                            if (!self._isAlive()) return;

                            if (text) {
                                self._processTextContent(text, richText);
                            } else if (onEmpty) {
                                onEmpty();
                            }
                        });
                    }
                );
            } else {
                this._clipboard.get_text(CLIPBOARD_TYPE, (clipboard, text) => {
                    if (!self || self._isDestroying || self._isDestroyed) return;
                    if (!self._isAlive()) return;

                    if (text) {
                        self._processTextContent(text, null);
                    } else if (onEmpty) {
                        onEmpty();
                    }
                });
            }
        }

        _processTextContent(plainText, richText) {
            if (!this._isAlive())
                return;

            if (!plainText || plainText.length === 0) return;

            this._maybeSuppressPendingImageForOcrText(plainText);

            if (this._settings.get_boolean('strip-whitespace')) {
                plainText = plainText.trim();
            }

            if (this._settings.get_boolean('ignore-passwords') && this._isSensitiveContent(plainText)) {
                return;
            }

            if (this._settings.get_boolean('deduplicate')) {
                const existing = this._findExistingTextEntry(plainText, richText);

                if (existing) {
                    if (this._settings.get_boolean('move-item-first')) {
                        this._moveEntryToFront(existing);
                        this._refreshMenu();
                    }
                    return;
                }
            }

            const entry = new ClipboardEntry(
                this._store.getNextId(),
                'text',
                { plain: plainText, rich: richText }
            );

            this._addEntry(entry);
        }

        _isSensitiveContent(text) {
            if (text.length < 8 || text.length > 5000) return false;

            const blockApiKeys = this._settings.get_boolean('ignore-api-keys');
            const blockHighEntropy = this._settings.get_boolean('ignore-high-entropy');
            const blockCards = this._settings.get_boolean('ignore-credit-cards');

            // API keys / credentials / private keys
            if (blockApiKeys) {
                for (const pattern of API_KEY_PATTERNS) {
                    if (pattern.test(text)) return true;
                }
            }

            // Credit / debit card numbers
            if (blockCards) {
                for (const pattern of CREDIT_CARD_PATTERNS) {
                    if (pattern.test(text)) return true;
                }
            }

            // High-entropy random strings (likely passwords / tokens with no recognisable prefix)
            if (blockHighEntropy &&
                text.length >= 12 && text.length <= 128 && !text.includes(' ')) {
                const entropy = this._calculateEntropy(text);
                if (entropy > 4.5 && this._hasMixedCharTypes(text)) {
                    return true;
                }
            }

            return false;
        }

        _calculateEntropy(text) {
            const freq = {};
            for (const char of text) {
                freq[char] = (freq[char] || 0) + 1;
            }

            let entropy = 0;
            const len = text.length;
            for (const char in freq) {
                const p = freq[char] / len;
                entropy -= p * Math.log2(p);
            }

            return entropy;
        }

        _hasMixedCharTypes(text) {
            const hasLower = /[a-z]/.test(text);
            const hasUpper = /[A-Z]/.test(text);
            const hasDigit = /[0-9]/.test(text);
            const hasSymbol = /[^a-zA-Z0-9]/.test(text);

            return [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length >= 3;
        }

        _processImageContent(imageData, mimeType = 'image/png') {
            if (!this._isAlive())
                return;

            if (!imageData) return;

            // Normalize to GLib.Bytes so size is always computed correctly.
            // Raw Uint8Arrays from clipboard callbacks can report buffer
            // capacity via .length instead of the actual data size.
            const normalizedData = toGBytes(imageData);
            if (!normalizedData) return;

            const maxSize = this._settings.get_int('max-image-size') * 1024 * 1024;
            const imageSize = normalizedData.get_size();

            if (imageSize === 0) return;
            if (imageSize > maxSize) {
                logWarn(`[Clipo] Skipping image over limit (${Math.round(imageSize / (1024 * 1024))}MB > ${this._settings.get_int('max-image-size')}MB)`);
                return;
            }
            if (isOversizedImage(normalizedData)) {
                const dimensions = getImageDimensions(normalizedData);
                logWarn(`[Clipo] Skipping oversized image (${dimensions.width}×${dimensions.height})`);
                return;
            }

            // Check for duplicate images
            if (this._settings.get_boolean('deduplicate')) {
                const existing = this._findExistingImageEntry(normalizedData);

                if (existing) {
                    if (this._settings.get_boolean('move-item-first')) {
                        this._moveEntryToFront(existing);
                        this._refreshMenu();
                    }
                    return;
                }
            }

            const entry = new ClipboardEntry(
                this._store.getNextId(),
                'image',
                {
                    data: normalizedData,
                    mimeType,
                    dimensions: getImageDimensions(normalizedData),
                }
            );

            this._addEntry(entry);
        }

        _schedulePendingImageCapture(imageData, mimeType = 'image/png') {
            if (!this._isAlive())
                return;

            if (!imageData || getByteLength(imageData) === 0) {
                return;
            }

            if (this._pendingImageCapture?.imageData) {
                this._processImageContent(
                    this._pendingImageCapture.imageData,
                    this._pendingImageCapture.mimeType
                );
                this._clearPendingImageCapture();
            }

            const createdAt = Date.now();
            this._pendingImageCapture = { imageData, mimeType, createdAt };
            this._lastImageTimestamp = createdAt;

            if (this._pendingImageTimeout) {
                GLib.source_remove(this._pendingImageTimeout);
                this._sourceIds.delete(this._pendingImageTimeout);
                this._pendingImageTimeout = null;
            }

            const self = this;
            let sourceId = 0;
            sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OCR_IMAGE_HOLD_MS, () => {
                self._sourceIds.delete(sourceId);
                if (!self || self._isDestroying || self._isDestroyed) {
                    self._pendingImageTimeout = null;
                    self._pendingImageCapture = null;
                    return GLib.SOURCE_REMOVE;
                }
                if (!self._isAlive()) {
                    self._pendingImageTimeout = null;
                    self._pendingImageCapture = null;
                    return GLib.SOURCE_REMOVE;
                }

                const pending = self._pendingImageCapture;
                self._pendingImageTimeout = null;
                self._pendingImageCapture = null;

                if (pending?.imageData) {
                    self._processImageContent(pending.imageData, pending.mimeType);
                }

                return GLib.SOURCE_REMOVE;
            });
            this._pendingImageTimeout = sourceId;
            this._sourceIds.add(sourceId);
        }

        _clearPendingImageCapture() {
            if (this._pendingImageTimeout) {
                GLib.source_remove(this._pendingImageTimeout);
                this._sourceIds.delete(this._pendingImageTimeout);
                this._pendingImageTimeout = null;
            }

            this._pendingImageCapture = null;
        }

        /**
         * Start a non-blocking Gio.FileMonitor on the TextExtractor screenshot
         * directory. Whenever a new file lands there we record Date.now() so that
         * _hasRecentTextExtractorScreenshotSignal() can do a pure in-memory check
         * with zero filesystem I/O — safe to call inside async clipboard callbacks.
         */
        _startTextExtractorMonitor() {
            this._stopTextExtractorMonitor();

            // Capture self for use inside deeply-nested async callbacks where `this`
            // could theoretically be rebound by the GJS async machinery.
            const self = this;

            // Do one non-blocking async query of the newest file mtime so the first
            // capture after startup is handled correctly, then rely on the monitor.
            try {
                const dir = Gio.File.new_for_path(TEXT_EXTRACTOR_SCREENSHOT_DIR);

                // Use query_info_async (the correct Gio async API) instead of the
                // non-existent query_exists_async which caused a crash at startup.
                dir.query_info_async(
                    'standard::type',
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_LOW,
                    null,
                    (file, res) => {
                        try {
                            file.query_info_finish(res);
                        } catch (_) {
                            // Directory doesn't exist or isn't accessible — silently bail.
                            // The TextExtractor dir will be created when the user first
                            // uses the extension; the monitor will be retried next enable().
                            return;
                        }

                        if (!self._isAlive()) return;

                        // Attach the live file monitor first so we don't miss events that
                        // arrive while the directory enumeration is in progress.
                        try {
                            const monitor = dir.monitor_directory(
                                Gio.FileMonitorFlags.NONE,
                                null
                            );
                            self._textExtractorMonitorChangedId = monitor.connect('changed', (_monitor, _file, _otherFile, eventType) => {
                                // CREATED or CHANGED means a new screenshot landed
                                if (eventType === Gio.FileMonitorEvent.CREATED ||
                                    eventType === Gio.FileMonitorEvent.CHANGED) {
                                    if (self._isAlive())
                                        self._lastTextExtractorFileMs = Date.now();
                                }
                            });
                            self._textExtractorMonitor = monitor;
                        } catch (e) {
                            logWarn('[Clipo] Could not monitor TextExtractor dir:', e.message);
                        }

                        // Seed the cached timestamp from the newest file on disk
                        // (async enumerate so we never block the main loop)
                        dir.enumerate_children_async(
                            'time::modified',
                            Gio.FileQueryInfoFlags.NONE,
                            GLib.PRIORITY_LOW,
                            null,
                            (d, r) => {
                                let enumerator;
                                try { enumerator = d.enumerate_children_finish(r); }
                                catch (_) { return; }
                                if (!enumerator) return;
                                if (!self._isAlive()) {
                                    try { enumerator.close_async(GLib.PRIORITY_LOW, null, null); } catch (_) { }
                                    return;
                                }

                                const readNext = () => {
                                    enumerator.next_files_async(10, GLib.PRIORITY_LOW, null, (e, r2) => {
                                        let infos;
                                        try { infos = e.next_files_finish(r2); }
                                        catch (_) {
                                            try { enumerator.close_async(GLib.PRIORITY_LOW, null, null); } catch (_) { }
                                            return;
                                        }
                                        if (!infos || infos.length === 0) {
                                            try { enumerator.close_async(GLib.PRIORITY_LOW, null, null); } catch (_) { }
                                            return;
                                        }
                                        if (!self._isAlive()) {
                                            try { enumerator.close_async(GLib.PRIORITY_LOW, null, null); } catch (_) { }
                                            return;
                                        }
                                        for (const info of infos) {
                                            const modSec = info.get_attribute_uint64('time::modified');
                                            const modMs = modSec * 1000;
                                            if (modMs > self._lastTextExtractorFileMs)
                                                self._lastTextExtractorFileMs = modMs;
                                        }
                                        readNext();
                                    });
                                };
                                readNext();
                            }
                        );
                    }
                );
            } catch (e) {
                logWarn('[Clipo] _startTextExtractorMonitor error:', e.message);
            }
        }

        _stopTextExtractorMonitor() {
            if (this._textExtractorMonitor) {
                if (this._textExtractorMonitorChangedId) {
                    try {
                        this._textExtractorMonitor.disconnect(this._textExtractorMonitorChangedId);
                    } catch (_) { }
                    this._textExtractorMonitorChangedId = 0;
                }

                try {
                    this._textExtractorMonitor.cancel();
                } catch (_) { }
                this._textExtractorMonitor = null;
            }
        }

        /**
         * Returns true if a TextExtractor screenshot was written within the last 5 s.
         * This is now a pure in-memory check — safe inside async callbacks.
         */
        _hasRecentTextExtractorScreenshotSignal() {
            if (!this._isAlive()) return false;
            return (Date.now() - this._lastTextExtractorFileMs) <= 5000;
        }

        _maybeSuppressPendingImageForOcrText(plainText) {
            if (!this._settings.get_boolean('has-text-extractor-extension')) {
                return;
            }

            if (!this._pendingImageCapture) {
                return;
            }

            const now = Date.now();
            const pendingAgeMs = now - this._pendingImageCapture.createdAt;
            if (pendingAgeMs > OCR_TEXT_MATCH_WINDOW_MS) {
                // The pending image is too old to be from this OCR cycle — commit it
                // and don't suppress the incoming text.
                return;
            }

            // If the file-monitor fired recently, we know a TextExtractor screenshot
            // triggered this whole sequence. Any text arriving in the match window is
            // the OCR result — suppress the intermediate image unconditionally.
            if (this._hasRecentTextExtractorScreenshotSignal()) {
                logDebug('[Clipo] TextExtractor OCR text received — discarding pending screenshot image');
                this._clearPendingImageCapture();
                return;
            }

            // Fallback: even without a file-monitor signal, if the text looks like
            // OCR output (has whitespace, meets minimum length) suppress the image.
            const normalized = plainText.trim();
            const hasLikelyOcrText = normalized.length >= OCR_MIN_TEXT_LENGTH && /\s/.test(normalized);
            if (hasLikelyOcrText) {
                logDebug('[Clipo] Likely OCR text received — discarding pending screenshot image');
                this._clearPendingImageCapture();
            }
        }

        _addEntry(entry) {
            this._history.prepend(entry);

            if (entry.type === 'text') {
                this._store.saveTextEntry(entry);
            } else {
                this._store.saveImageEntry(entry);
            }

            this._pruneHistory();
            this._refreshMenu();
        }

        _computeHash(text) {
            if (text.length > 500) {
                return text.length + text.charCodeAt(0) + text.charCodeAt(text.length - 1);
            }
            let hash = 0;
            for (let i = 0; i < text.length; i++) {
                hash = ((hash << 5) - hash) + text.charCodeAt(i);
                hash = hash & hash;
            }
            return hash;
        }

        _moveEntryToFront(entry) {
            if (entry.pinned) {
                this._pinned.moveToFront(entry);
            } else {
                this._history.moveToFront(entry);
            }
        }

        _findExistingTextEntry(plainText, richText) {
            return this._findMatchingEntry(entry =>
                entry.type === 'text' &&
                entry.plain === plainText &&
                (entry.rich || null) === (richText || null)
            );
        }

        _findExistingImageEntry(imageData) {
            return this._findMatchingEntry(entry =>
                entry.type === 'image' &&
                entry.imageData &&
                bytesEqual(entry.imageData, imageData)
            );
        }

        _findMatchingEntry(predicate) {
            let current = this._pinned.first;
            while (current) {
                if (predicate(current))
                    return current;
                current = current.next;
            }

            current = this._history.first;
            while (current) {
                if (predicate(current))
                    return current;
                current = current.next;
            }

            return null;
        }

        _pruneHistory() {
            const maxSize = this._settings.get_int('history-size');

            let current = this._history.last;
            while (this._history.size > maxSize && current) {
                const prev = current.prev;
                if (!current.pinned) {
                    this._history.remove(current);
                    this._store.deleteEntry(current);
                }
                current = prev;
            }

            // Cache-size pruning: call getCacheSize() once outside the loop to avoid
            // repeated disk I/O (stat calls) which can stall the GNOME Shell main loop.
            if (this._store.getCacheSize) {
                const quotaBytes = (this._settings.get_int('cache-size') || 100) * 1024 * 1024;
                let cacheBytes = this._store.getCacheSize();
                if (cacheBytes > quotaBytes) {
                    current = this._history.last;
                    while (current && cacheBytes > quotaBytes) {
                        const prev = current.prev;
                        if (!current.pinned) {
                            // Estimate how many bytes this entry frees
                            const entryBytes = this._store.getEntryDiskSize
                                ? this._store.getEntryDiskSize(current)
                                : current.getByteSize();
                            this._history.remove(current);
                            this._store.deleteEntry(current);
                            cacheBytes = Math.max(0, cacheBytes - entryBytes);
                        }
                        current = prev;
                    }
                }
            }
        }

        _selectEntry(entry) {
            if (entry.type === 'text') {
                this._debouncing++;
                if (entry.rich && !this._settings.get_boolean('prefer-plain-text')) {
                    this._clipboard.set_content(
                        CLIPBOARD_TYPE,
                        'text/html',
                        toGBytes(new TextEncoder().encode(entry.rich))
                    );
                }
                this._clipboard.set_text(CLIPBOARD_TYPE, entry.plain || '');
            } else if (entry.type === 'image') {
                const imageData = this._store.loadImageData(entry);
                if (!imageData) {
                    logWarn('[Clipo] Could not load image data for clipboard selection');
                    return;
                }

                this._debouncing++;
                this._clipboard.set_content(
                    CLIPBOARD_TYPE,
                    entry.imageMimeType || 'image/png',
                    imageData
                );
            }

            const shouldMoveToFront = this._settings.get_boolean('move-item-first');
            if (shouldMoveToFront) {
                this._moveEntryToFront(entry);
                this._store.syncFromLists(this._history.toArray(), this._pinned.toArray());
            }

            this._updateSelection(entry);

            if (shouldMoveToFront) {
                this._refreshMenu();
            }

            if (this._settings.get_boolean('close-on-select')) {
                this.menu.close();
            }

            if (this._settings.get_boolean('paste-on-select')) {
                this._triggerPaste();
            }
        }

        _updateSelection(entry) {
            if (this._selectedEntry && this._selectedEntry.menuItem) {
                this._selectedEntry.menuItem.setSelected(false);
            }

            this._selectedEntry = entry;

            if (entry && entry.menuItem) {
                entry.menuItem.setSelected(true);
            }
        }

        _triggerPaste() {
            if (!this._virtualKeyboard) {
                const seat = Clutter.get_default_backend().get_default_seat();
                this._virtualKeyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            }
            const keyboard = this._virtualKeyboard;

            if (this._pasteTimeoutId) {
                GLib.source_remove(this._pasteTimeoutId);
                this._sourceIds.delete(this._pasteTimeoutId);
                this._pasteTimeoutId = null;
            }

            let sourceId = 0;
            sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._sourceIds.delete(sourceId);
                this._pasteTimeoutId = null;
                keyboard.notify_keyval(Clutter.get_current_event_time(), Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
                keyboard.notify_keyval(Clutter.get_current_event_time(), Clutter.KEY_v, Clutter.KeyState.PRESSED);
                keyboard.notify_keyval(Clutter.get_current_event_time(), Clutter.KEY_v, Clutter.KeyState.RELEASED);
                keyboard.notify_keyval(Clutter.get_current_event_time(), Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
                return GLib.SOURCE_REMOVE;
            });
            this._pasteTimeoutId = sourceId;
            this._sourceIds.add(sourceId);
        }

        _togglePin(entry) {
            entry.pinned = !entry.pinned;

            if (entry.pinned) {
                this._history.remove(entry);
                this._pinned.prepend(entry);
            } else {
                this._pinned.remove(entry);
                this._history.prepend(entry);
            }

            this._store.syncFromLists(this._history.toArray(), this._pinned.toArray());
            this._refreshMenu();
        }

        _deleteEntry(entry) {
            if (entry.pinned) {
                this._pinned.remove(entry);
            } else {
                this._history.remove(entry);
            }

            this._store.deleteEntry(entry);

            if (entry.menuItem) {
                entry.menuItem.destroy();
            }

            this._refreshMenu();
        }

        _clearHistory() {
            this._showClearConfirmDialog();
        }

        _showClearConfirmDialog() {
            const dialog = new ModalDialog.ModalDialog({
                styleClass: 'clipo-confirm-dialog',
                destroyOnClose: true,
            });

            const content = new St.BoxLayout({
                vertical: true,
                style_class: 'clipo-confirm-content',
            });

            const icon = new St.Icon({
                icon_name: 'user-trash-symbolic',
                icon_size: 48,
                style_class: 'clipo-confirm-icon',
            });
            content.add_child(icon);

            const title = new St.Label({
                text: _('Clear clipboard history?'),
                style_class: 'clipo-confirm-title',
            });
            content.add_child(title);

            const message = new St.Label({
                text: _('Pinned items will not be removed.'),
                style_class: 'clipo-confirm-message',
            });
            message.clutter_text.line_wrap = true;
            content.add_child(message);

            dialog.contentLayout.add_child(content);

            dialog.addButton({
                label: _('Cancel'),
                action: () => dialog.close(),
                key: Clutter.KEY_Escape,
            });

            dialog.addButton({
                label: _('Clear'),
                action: () => {
                    this._performClearHistory();
                    dialog.close();
                },
                default: true,
                destructive_action: true,
            });

            this.menu.close();
            dialog.open();
        }

        _performClearHistory() {
            this._selectedEntry = null;
            const items = this._history.toArray();
            for (const entry of items) {
                if (entry.menuItem) {
                    entry.menuItem.destroy();
                }
            }
            this._history.clear();
            this._store.clearNonPinned();
            this._refreshMenu();
        }

        _onMenuOpened() {
            if (!this._isAlive())
                return;

            if (this._menuNeedsRefresh)
                this._refreshMenu(true);

            this._resetScrollToTop();

            if (this._focusTimeout) {
                GLib.source_remove(this._focusTimeout);
                this._sourceIds.delete(this._focusTimeout);
            }

            let sourceId = 0;
            sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                this._sourceIds.delete(sourceId);
                if (!this._isAlive()) {
                    this._focusTimeout = null;
                    return GLib.SOURCE_REMOVE;
                }

                if (this._searchEntry) {
                    this._focusTimeout = null;
                    this._searchEntry.grab_key_focus();
                    return GLib.SOURCE_REMOVE;
                }

                const firstItem = this._getFirstFocusableItem();
                if (firstItem) {
                    firstItem.grab_key_focus();
                    this._ensureActorVisible(firstItem);
                }
                this._focusTimeout = null;
                return GLib.SOURCE_REMOVE;
            });
            this._focusTimeout = sourceId;
            this._sourceIds.add(sourceId);
        }

        _resetScrollToTop() {
            if (!this._isAlive() || !this._scrollView)
                return;

            if (this._menuScrollResetIdleId) {
                GLib.source_remove(this._menuScrollResetIdleId);
                this._sourceIds.delete(this._menuScrollResetIdleId);
                this._menuScrollResetIdleId = null;
            }

            let sourceId = 0;
            sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._sourceIds.delete(sourceId);
                if (this._menuScrollResetIdleId === sourceId)
                    this._menuScrollResetIdleId = null;

                if (!this._isAlive() || !this._scrollView)
                    return GLib.SOURCE_REMOVE;

                const vAdjustment = this._scrollView.vscroll?.adjustment
                    || this._scrollView.get_vscroll_bar?.()?.get_adjustment?.()
                    || this._scrollView.vadjustment;

                if (vAdjustment && typeof vAdjustment.set_value === 'function') {
                    const lower = typeof vAdjustment.get_lower === 'function'
                        ? vAdjustment.get_lower()
                        : 0;
                    vAdjustment.set_value(lower);
                }

                return GLib.SOURCE_REMOVE;
            });
            this._menuScrollResetIdleId = sourceId;
            this._sourceIds.add(sourceId);
        }

        _getFirstFocusableItem() {
            if (!this._itemsBox)
                return null;

            for (const child of this._itemsBox.get_children()) {
                if (child && child.can_focus)
                    return child;
            }

            return null;
        }

        _findFocusableSibling(actor, direction) {
            if (!actor || (direction !== 1 && direction !== -1))
                return null;

            let sibling = direction === 1 ? actor.get_next_sibling() : actor.get_previous_sibling();
            while (sibling) {
                if (sibling.can_focus)
                    return sibling;
                sibling = direction === 1 ? sibling.get_next_sibling() : sibling.get_previous_sibling();
            }

            return null;
        }

        _queueEnsureActorVisible(actor) {
            if (!this._isAlive() || !actor)
                return;

            if (this._ensureVisibleIdleId) {
                GLib.source_remove(this._ensureVisibleIdleId);
                this._sourceIds.delete(this._ensureVisibleIdleId);
                this._ensureVisibleIdleId = null;
            }

            let sourceId = 0;
            sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._sourceIds.delete(sourceId);
                if (this._ensureVisibleIdleId === sourceId)
                    this._ensureVisibleIdleId = null;

                if (!this._isAlive() || isActorDestroyed(actor))
                    return GLib.SOURCE_REMOVE;

                this._ensureActorVisible(actor);
                return GLib.SOURCE_REMOVE;
            });

            this._ensureVisibleIdleId = sourceId;
            this._sourceIds.add(sourceId);
        }

        _ensureActorVisible(actor) {
            if (!this._isAlive() || !this._scrollView || !actor)
                return;

            if (typeof this._scrollView.ensure_actor_visible === 'function') {
                try {
                    this._scrollView.ensure_actor_visible(actor);
                } catch (_) { }
            }

            const vAdjustment = this._scrollView.vscroll?.adjustment
                || this._scrollView.get_vscroll_bar?.()?.get_adjustment?.()
                || this._scrollView.vadjustment;

            if (!vAdjustment)
                return;

            const currentValue = typeof vAdjustment.get_value === 'function'
                ? vAdjustment.get_value()
                : vAdjustment.value;
            const pageSize = typeof vAdjustment.get_page_size === 'function'
                ? vAdjustment.get_page_size()
                : vAdjustment.page_size;
            const lower = typeof vAdjustment.get_lower === 'function'
                ? vAdjustment.get_lower()
                : vAdjustment.lower;
            const upper = typeof vAdjustment.get_upper === 'function'
                ? vAdjustment.get_upper()
                : vAdjustment.upper;

            if ([currentValue, pageSize, lower, upper].some(v => typeof v !== 'number'))
                return;

            let actorTop = actor.get_y();
            if (this._itemsBox
                && typeof actor.get_transformed_position === 'function'
                && typeof this._itemsBox.get_transformed_position === 'function') {
                const [, actorY] = actor.get_transformed_position();
                const [, itemsBoxY] = this._itemsBox.get_transformed_position();
                actorTop = actorY - itemsBoxY;
            }

            const actorBottom = actorTop + actor.get_height();
            let targetValue = currentValue;

            if (actorTop < currentValue) {
                targetValue = actorTop;
            } else if (actorBottom > currentValue + pageSize) {
                targetValue = actorBottom - pageSize;
            }

            const maxValue = Math.max(lower, upper - pageSize);
            targetValue = Math.max(lower, Math.min(targetValue, maxValue));

            if (typeof vAdjustment.set_value === 'function')
                vAdjustment.set_value(targetValue);
        }

        _onSearchChanged() {
            if (!this._searchEntry) {
                return;
            }

            const query = this._searchEntry.get_text();
            this._searchQuery = query;

            if (!query || query.length === 0) {
                this._searchResults = null;
                this._refreshMenu();
                return;
            }

            const results = [];

            // Search pinned first
            let current = this._pinned.first;
            while (current) {
                if (this._matchesSearch(current, query)) {
                    results.push(current);
                }
                current = current.next;
            }

            // Then history
            current = this._history.first;
            while (current) {
                if (this._matchesSearch(current, query)) {
                    results.push(current);
                }
                current = current.next;
            }

            this._searchResults = results;
            this._refreshMenu();
        }

        _matchesSearch(entry, query) {
            if (entry.type === 'image') return false;

            const text = entry.plain || '';
            const regex = this._buildSearchRegex(query);
            if (regex) {
                return regex.test(text);
            }

            return text.toLowerCase().includes(query.toLowerCase());
        }

        _buildSearchRegex(query) {
            if (!query)
                return null;

            // Prevent pathological regex patterns from locking up the UI during live search.
            if (query.length > MAX_REGEX_QUERY_LENGTH)
                return null;

            if (/(\([^)]*[+*][^)]*\))[+*{]|\[[^\]]*[+*][^\]]*\][+*{]|\{\d+,\d*\}\+/.test(query))
                return null;

            try {
                return new RegExp(query, 'i');
            } catch (_) {
                return null;
            }
        }

        _isMenuOpen() {
            return this._menuIsOpen || Boolean(this.menu?.isOpen);
        }

        _refreshMenu(force = false) {
            if (!this._isAlive() || !this._itemsBox)
                return;

            if (!force && !this._isMenuOpen()) {
                this._menuNeedsRefresh = true;
                return;
            }

            this._menuNeedsRefresh = false;

            if (this._animTimeouts) {
                for (const id of this._animTimeouts) {
                    GLib.source_remove(id);
                    this._sourceIds.delete(id);
                }
                this._animTimeouts = [];
            }

            if (this._selectedEntry && !this._history.findById(this._selectedEntry.id) && !this._pinned.findById(this._selectedEntry.id)) {
                this._selectedEntry = null;
            }

            this._itemsBox.destroy_all_children();

            let itemIndex = 0;

            if (this._searchResults) {
                // Show search results
                if (this._searchResults.length === 0) {
                    this._showEmptyState(_('No matches found'));
                } else {
                    for (const entry of this._searchResults) {
                        const item = new ClipboardItem(entry, this);
                        item.highlightSearch(this._searchQuery);
                        this._itemsBox.add_child(item);
                        this._animateItemIn(item, itemIndex++);
                    }
                }
                this._updateCountBadge(this._searchResults.length);
            } else {
                // Show all items: pinned first, then history
                const hasPinned = this._pinned.size > 0;
                const hasHistory = this._history.size > 0;
                const totalCount = this._pinned.size + this._history.size;

                if (!hasPinned && !hasHistory) {
                    this._showEmptyState(_('Clipboard is empty'));
                    this._updateCountBadge(0);
                } else {
                    // Pinned section
                    if (hasPinned) {
                        this._itemsBox.add_child(this._makeSectionHeader(_('Pinned')));
                        let current = this._pinned.first;
                        while (current) {
                            const item = new ClipboardItem(current, this);
                            this._itemsBox.add_child(item);
                            this._animateItemIn(item, itemIndex++);
                            current = current.next;
                        }
                    }

                    // Divider + Recent section
                    if (hasPinned && hasHistory) {
                        const sep = new St.Widget({
                            style_class: 'clipo-separator',
                            x_expand: true,
                        });
                        this._itemsBox.add_child(sep);
                    }

                    if (hasHistory) {
                        if (hasPinned) {
                            this._itemsBox.add_child(this._makeSectionHeader('Recent'));
                        }
                        let current = this._history.first;
                        while (current) {
                            const item = new ClipboardItem(current, this);
                            this._itemsBox.add_child(item);
                            this._animateItemIn(item, itemIndex++);
                            current = current.next;
                        }
                    }

                    this._updateCountBadge(totalCount);
                }
            }

            // Update selection visual
            if (this._selectedEntry && this._selectedEntry.menuItem) {
                this._selectedEntry.menuItem.setSelected(true);
            }
        }

        _makeSectionHeader(text) {
            return new St.Label({
                text,
                style_class: 'clipo-section-header',
                x_expand: true,
            });
        }

        _updateCountBadge(count) {
            if (!this._countBadge) return;
            if (count === 0) {
                this._countBadge.text = '';
            } else {
                this._countBadge.text = count === 1 ? _('1 item') : _('%d items').format(count);
            }
        }

        _animateItemIn(item, index) {
            if (!this._isAlive())
                return;

            item.opacity = 255;
            item.translation_y = 0;
        }

        _connectTrackedSignal(target, signal, handler) {
            if (!target || typeof target.connect !== 'function')
                return 0;

            const id = target.connect(signal, handler);
            this._signalHandlers.push([target, id]);
            return id;
        }

        _disconnectTrackedSignals() {
            for (const [target, id] of this._signalHandlers) {
                try {
                    if (target && id)
                        target.disconnect(id);
                } catch (_) { }
            }

            this._signalHandlers = [];
        }

        _showEmptyState(message) {
            const emptyBox = new St.BoxLayout({
                vertical: true,
                style_class: 'clipo-empty-state',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const icon = new St.Icon({
                icon_name: 'edit-paste-symbolic',
                icon_size: 48,
                style_class: 'clipo-empty-icon',
            });
            emptyBox.add_child(icon);

            const label = new St.Label({
                text: message,
                style_class: 'clipo-empty-label',
            });
            emptyBox.add_child(label);

            this._itemsBox.add_child(emptyBox);

            // Subtle fade-in animation for empty state
            emptyBox.opacity = 0;
            emptyBox.ease({
                opacity: 255,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        _togglePrivateMode() {
            this._privateMode = !this._privateMode;
            this._settings.set_boolean('private-mode', this._privateMode);
            this._updatePrivateButton();
        }

        _updatePrivateButton() {
            if (this._privateMode) {
                this._privateButton.add_style_class_name('clipo-private-active');
                if (typeof this._privateButton.set_accessible_name === 'function')
                    this._privateButton.set_accessible_name(_('Private mode on'));
                else
                    this._privateButton.accessible_name = _('Private mode on');

                if (typeof this._privateButton.set_tooltip_text === 'function')
                    this._privateButton.set_tooltip_text(_('Private mode is on'));
                else
                    this._privateButton.tooltip_text = _('Private mode is on');
            } else {
                this._privateButton.remove_style_class_name('clipo-private-active');
                if (typeof this._privateButton.set_accessible_name === 'function')
                    this._privateButton.set_accessible_name(_('Private mode off'));
                else
                    this._privateButton.accessible_name = _('Private mode off');

                if (typeof this._privateButton.set_tooltip_text === 'function')
                    this._privateButton.set_tooltip_text(_('Private mode is off'));
                else
                    this._privateButton.tooltip_text = _('Private mode is off');
            }
        }

        _openSettings() {
            this.menu.close();
            this._extension.openPreferences();
        }

        destroy() {
            // Guard against re-entrant destroy (e.g. GC sweep triggering
            // destroy on an actor that is already being torn down).
            if (this._isDestroying || this._isDestroyed)
                return;

            this._isDestroying = true;

            try {
                if (this._cursorAnchor) {
                    this._cursorAnchor.destroy();
                    this._cursorAnchor = null;
                }

                if (this._clipboardChangeTimeout) {
                    GLib.source_remove(this._clipboardChangeTimeout);
                    this._sourceIds.delete(this._clipboardChangeTimeout);
                    this._clipboardChangeTimeout = null;
                }

                if (this._focusTimeout) {
                    GLib.source_remove(this._focusTimeout);
                    this._sourceIds.delete(this._focusTimeout);
                    this._focusTimeout = null;
                }

                if (this._menuRepositionIdleId) {
                    GLib.source_remove(this._menuRepositionIdleId);
                    this._sourceIds.delete(this._menuRepositionIdleId);
                    this._menuRepositionIdleId = null;
                }

                if (this._menuScrollResetIdleId) {
                    GLib.source_remove(this._menuScrollResetIdleId);
                    this._sourceIds.delete(this._menuScrollResetIdleId);
                    this._menuScrollResetIdleId = null;
                }

                if (this._ensureVisibleIdleId) {
                    GLib.source_remove(this._ensureVisibleIdleId);
                    this._sourceIds.delete(this._ensureVisibleIdleId);
                    this._ensureVisibleIdleId = null;
                }

                if (this._pasteTimeoutId) {
                    GLib.source_remove(this._pasteTimeoutId);
                    this._sourceIds.delete(this._pasteTimeoutId);
                    this._pasteTimeoutId = null;
                }

                if (this._animTimeouts) {
                    for (const id of this._animTimeouts) {
                        GLib.source_remove(id);
                        this._sourceIds.delete(id);
                    }
                    this._animTimeouts = [];
                }

                this._clearPendingImageCapture();
                this._stopTextExtractorMonitor();

                this._disconnectTrackedSignals();

                for (const id of this._sourceIds) {
                    try {
                        GLib.source_remove(id);
                    } catch (_) { }
                }
                this._sourceIds.clear();

                if (this._ownerChangedId) {
                    this._selection.disconnect(this._ownerChangedId);
                    this._ownerChangedId = null;
                }

                if (this._settingsChangedId) {
                    this._settings.disconnect(this._settingsChangedId);
                    this._settingsChangedId = null;
                }

                this._unregisterKeybindings();
            } catch (e) {
                logError('[Clipo] Error during destroy cleanup:', e);
            }

            this._isDestroyed = true;
            this._isDestroying = false;

            super.destroy();
        }
    });

/**
 * Extension Entry Point
 */
export default class ClipoExtension extends Extension {
    enable() {
        // Destroy any leftover indicator from a previous enable() cycle
        // to prevent "Extension point conflict" errors.
        if (this._indicator) {
            try {
                this._indicator.destroy();
            } catch (_) { }
            this._indicator = null;
        }

        this._indicator = new ClipboardIndicator(this);
        Main.panel.addToStatusArea('clipo', this._indicator);
    }

    disable() {
        if (this._indicator) {
            try {
                this._indicator.destroy();
            } catch (_) { }
            this._indicator = null;
        }
    }
}

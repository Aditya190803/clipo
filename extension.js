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
import GdkPixbuf from 'gi://GdkPixbuf';
import Cogl from 'gi://Cogl';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ClipboardEntry, LinkedList } from './dataStructures.js';
import { Store } from './store.js';

// Constants
const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;
const THUMBNAIL_SIZE = 48;
const MAX_PREVIEW_LENGTH = 150;
const IMAGE_PREVIEW_MARGIN = 24;
const IMAGE_PREVIEW_FRAME = 12;
const OCR_IMAGE_HOLD_MS = 2200;
const OCR_TEXT_MATCH_WINDOW_MS = 3000;
const OCR_MIN_TEXT_LENGTH = 8;
const TEXT_EXTRACTOR_SCREENSHOT_DIR = GLib.build_filenamev([GLib.get_home_dir(), 'Pictures', 'Screenshots', 'TextExtractor']);
const POPUP_EDGE_MARGIN = 16;

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

// Sensitive content patterns
const SENSITIVE_PATTERNS = [
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
            y_align: Clutter.ActorAlign.FILL,
            y_expand: true,
        });

        this._deleteButton = new St.Button({
            style_class: 'clipo-delete-button',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: 16,
            }),
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._deleteButton.connect('clicked', this._onDeleteClicked.bind(this));
        this._actionsBox.add_child(this._deleteButton);

        // Spacer to push pin to the bottom
        this._actionsBox.add_child(new St.Widget({ y_expand: true }));

        this._pinButton = new St.Button({
            style_class: this.entry.pinned ? 'clipo-pin-button clipo-pinned' : 'clipo-pin-button',
            child: new St.Icon({
                icon_name: 'view-pin-symbolic',
                icon_size: 16,
            }),
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this._pinButton.connect('clicked', this._onPinClicked.bind(this));
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
        labelText.line_wrap_mode = 0; // PANGO_WRAP_WORD
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
        if (this._indicator && !this._indicator._settings.get_boolean('show-thumbnails')) {
            this._addImageFallback();
            return;
        }
        let pixbuf = null;
        if (this.entry.imageData) {
            try {
                pixbuf = this._loadPixbuf(this.entry.imageData);
            } catch (e) {
                console.error('[Clipo] Failed to load image preview:', e);
            }
        }

        if (pixbuf) {
            try {
                const thumbnailPixbuf = this._createLargeThumbnail(pixbuf);
                if (thumbnailPixbuf) {
                    const thumbWidth = thumbnailPixbuf.get_width();
                    const thumbHeight = thumbnailPixbuf.get_height();

                    const thumbnailWidget = this._createPixbufActor(
                        thumbnailPixbuf,
                        'clipo-thumbnail',
                        thumbWidth,
                        thumbHeight
                    );

                    if (thumbnailWidget) {
                        this._contentBox.add_child(thumbnailWidget);
                        this._contentBox.add_child(this._buildImageMeta());
                        this._thumbnailActor = thumbnailWidget;
                        this._setupImageHoverPreview();
                        return;
                    }
                }
            } catch (e) {
                console.error('[Clipo] Failed to create thumbnail:', e);
            }
        }

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

    _loadPixbuf(imageData) {
        if (!imageData) return null;

        // Ensure we have GLib.Bytes for the stream
        let gbytes = toGBytes(imageData);
        if (!gbytes || gbytes.get_size() === 0) {
            console.error('[Clipo] Invalid image data: empty or null');
            return null;
        }

        const stream = Gio.MemoryInputStream.new_from_bytes(gbytes);
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
            if (!pixbuf) {
                console.error('[Clipo] Failed to create pixbuf from stream');
                return null;
            }
            console.log('[Clipo] Successfully loaded image:', pixbuf.get_width(), 'x', pixbuf.get_height());
            return pixbuf;
        } catch (e) {
            console.error('[Clipo] Failed to load image:', e.message);
            return null;
        } finally {
            try { stream.close(null); } catch (e) {}
        }
    }

    _createPixbufActor(pixbuf, styleClass, width, height) {
        const hasAlpha = pixbuf.get_has_alpha();
        const pixelFormat = hasAlpha
            ? Cogl.PixelFormat.RGBA_8888
            : Cogl.PixelFormat.RGB_888;
        const pixWidth = pixbuf.get_width();
        const pixHeight = pixbuf.get_height();
        const rowstride = pixbuf.get_rowstride();

        let content;

        try {
            // GNOME 46+ path: St.ImageContent
            if (St.ImageContent && typeof St.ImageContent.new_with_preferred_size === 'function') {
                content = St.ImageContent.new_with_preferred_size(pixWidth, pixHeight);
                const pixelBytes = pixbuf.read_pixel_bytes();
                const setBytesArgs = [];
                const mutterBackend = global.stage?.context?.get_backend?.();

                // GNOME Shell 48+ expects the active Cogl context as the first argument.
                if (content.set_bytes.length === 6 && mutterBackend?.get_cogl_context)
                    setBytesArgs.push(mutterBackend.get_cogl_context());

                content.set_bytes(
                    ...setBytesArgs,
                    pixelBytes,
                    pixelFormat,
                    pixWidth,
                    pixHeight,
                    rowstride
                );
            } else if (Clutter.Image) {
                // Older GNOME path: Clutter.Image
                content = new Clutter.Image();
                // set_data expects a raw Uint8Array/Buffer, not GLib.Bytes
                const rawPixels = pixbuf.read_pixel_bytes().get_data();
                if (typeof content.set_data === 'function') {
                    content.set_data(rawPixels, pixelFormat, pixWidth, pixHeight, rowstride);
                } else {
                    content.set_bytes(
                        new GLib.Bytes(rawPixels),
                        pixelFormat, pixWidth, pixHeight, rowstride
                    );
                }
            } else {
                console.error('[Clipo] No compatible image content API found');
                return null;
            }
        } catch (e) {
            console.error('[Clipo] Failed to set image content:', e);
            return null;
        }

        const actor = new Clutter.Actor({
            content,
            content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
            width,
            height,
            clip_to_allocation: true,
        });

        return new St.Bin({
            style_class: styleClass,
            child: actor,
            width,
            height,
            reactive: true,
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _buildImageMeta() {
        let dimensions = '';
        let sizeText = '';

        try {
            if (this.entry.imageData) {
                const pixbuf = this._loadPixbuf(this.entry.imageData);
                if (pixbuf) {
                    dimensions = `${pixbuf.get_width()}×${pixbuf.get_height()}`;
                }
            }
        } catch (_) {
            dimensions = '';
        }

        const bytes = getByteLength(this.entry.imageData);
        if (bytes > 0)
            sizeText = `${Math.max(1, Math.round(bytes / 1024))} KB`;

        const meta = [dimensions, sizeText].filter(Boolean).join('  •  ');

        const infoBox = new St.BoxLayout({
            vertical: true,
            style_class: 'clipo-image-info',
            x_expand: true,
        });

        infoBox.add_child(new St.Label({
            text: _('Screenshot'),
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
    
    _setupImageHoverPreview() {
        if (!this._thumbnailActor || !this.entry.imageData) return;
        
        this._thumbnailActor.connect('enter-event', () => {
            this._showImagePreview();
            return Clutter.EVENT_PROPAGATE;
        });
        
        this._thumbnailActor.connect('leave-event', () => {
            this._hideImagePreview();
            return Clutter.EVENT_PROPAGATE;
        });
    }
    
    _showImagePreview() {
        if (this._previewPopup) return;
        
        try {
            const pixbuf = this._loadPixbuf(this.entry.imageData);
            
            if (!pixbuf) return;
            
            const origWidth = pixbuf.get_width();
            const origHeight = pixbuf.get_height();
            
            const monitor = Main.layoutManager.currentMonitor;
            const maxWidth = monitor ? Math.max(160, monitor.width - IMAGE_PREVIEW_MARGIN * 2) : origWidth;
            const maxHeight = monitor ? Math.max(160, monitor.height - IMAGE_PREVIEW_MARGIN * 2) : origHeight;
            let previewWidth = origWidth;
            let previewHeight = origHeight;
            
            if (origWidth > maxWidth || origHeight > maxHeight) {
                const scale = Math.min(maxWidth / origWidth, maxHeight / origHeight);
                previewWidth = Math.floor(origWidth * scale);
                previewHeight = Math.floor(origHeight * scale);
            }
            
            const scaledPixbuf = pixbuf.scale_simple(
                previewWidth,
                previewHeight,
                GdkPixbuf.InterpType.BILINEAR
            );

            if (!scaledPixbuf) {
                return;
            }
            
            const previewActor = this._createPixbufActor(
                scaledPixbuf,
                'clipo-image-preview-actor',
                previewWidth,
                previewHeight
            );

            const popupWidth = previewWidth + IMAGE_PREVIEW_FRAME;
            const popupHeight = previewHeight + IMAGE_PREVIEW_FRAME;
            
            this._previewPopup = new St.BoxLayout({
                style_class: 'clipo-image-preview-popup',
                vertical: true,
                reactive: false,
                can_focus: false,
                width: popupWidth,
                height: popupHeight,
                clip_to_allocation: true,
            });
            
            this._previewPopup.add_child(previewActor);
            
            const [thumbX, thumbY] = this._thumbnailActor.get_transformed_position();
            const [thumbWidth, thumbHeight] = this._thumbnailActor.get_transformed_size();
            const monitorX = monitor ? monitor.x : 0;
            const monitorY = monitor ? monitor.y : 0;
            const monitorWidth = monitor ? monitor.width : global.stage.width;
            const monitorHeight = monitor ? monitor.height : global.stage.height;

            const minX = monitorX + IMAGE_PREVIEW_MARGIN;
            const maxX = monitorX + monitorWidth - popupWidth - IMAGE_PREVIEW_MARGIN;
            const minY = monitorY + IMAGE_PREVIEW_MARGIN;
            const maxY = monitorY + monitorHeight - popupHeight - IMAGE_PREVIEW_MARGIN;

            // Prefer showing preview to the left of the thumbnail; fall back to right if needed.
            const preferredLeftX = Math.floor(thumbX - popupWidth - 12);
            const fallbackRightX = Math.floor(thumbX + thumbWidth + 12);
            let previewX = preferredLeftX;
            if (previewX < minX) {
                previewX = Math.min(fallbackRightX, maxX);
            }
            previewX = Math.max(minX, Math.min(previewX, maxX));

            let previewY = Math.floor(thumbY + (thumbHeight - popupHeight) / 2);
            previewY = Math.max(minY, Math.min(previewY, maxY));

            this._previewPopup.set_position(previewX, previewY);
            
            Main.uiGroup.add_child(this._previewPopup);
        } catch (e) {
            console.error('[Clipo] Failed to show image preview:', e);
        }
    }
    
    _hideImagePreview() {
        if (this._previewPopup) {
            this._previewPopup.destroy();
            this._previewPopup = null;
        }
    }
    
    _createThumbnail(pixbuf) {
        if (!pixbuf) return null;
        
        const width = pixbuf.get_width();
        const height = pixbuf.get_height();
        const scale = Math.min(THUMBNAIL_SIZE / width, THUMBNAIL_SIZE / height);
        
        return pixbuf.scale_simple(
            Math.floor(width * scale),
            Math.floor(height * scale),
            GdkPixbuf.InterpType.BILINEAR
        );
    }
    
    _createLargeThumbnail(pixbuf) {
        if (!pixbuf) return null;

        const width = pixbuf.get_width();
        const height = pixbuf.get_height();

        const configuredMenuWidth = this._indicator?._settings?.get_int('window-width') || 400;
        // Keep thumbnail width in sync with user-configurable menu width.
        const maxWidth = Math.max(140, configuredMenuWidth - 100);
        // Cap height so tall images don't make the list unwieldy
        const maxHeight = 120;

        const scale = Math.min(maxWidth / width, maxHeight / height, 1); // never upscale

        return pixbuf.scale_simple(
            Math.max(1, Math.floor(width * scale)),
            Math.max(1, Math.floor(height * scale)),
            GdkPixbuf.InterpType.BILINEAR
        );
    }
    
    _formatPreview(text) {
        let preview = text.replace(/\s+/g, ' ').trim();
        if (preview.length > MAX_PREVIEW_LENGTH) {
            preview = preview.substring(0, MAX_PREVIEW_LENGTH) + '…';
        }
        return preview;
    }
    
    _connectSignals() {
        this.connect('key-press-event', (actor, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Down) {
                const next = this.get_next_sibling();
                if (next && next.can_focus) { next.grab_key_focus(); return Clutter.EVENT_STOP; }
            } else if (key === Clutter.KEY_Up) {
                const prev = this.get_previous_sibling();
                if (prev && prev.can_focus) { prev.grab_key_focus(); return Clutter.EVENT_STOP; }
                else if (!prev && this._indicator && this._indicator._searchEntry) {
                    this._indicator._searchEntry.grab_key_focus(); return Clutter.EVENT_STOP; 
                }
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
        
        this.connect('key-press-event', (actor, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
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
        
        const lowerPreview = preview.toLowerCase();
        const lowerSearch = searchQuery.toLowerCase();
        const idx = lowerPreview.indexOf(lowerSearch);
        
        if (idx >= 0) {
            const before = GLib.markup_escape_text(preview.substring(0, idx), -1);
            const match = GLib.markup_escape_text(preview.substring(idx, idx + searchQuery.length), -1);
            const after = GLib.markup_escape_text(preview.substring(idx + searchQuery.length), -1);
            
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
        this._debouncing = 0;
        this._privateMode = this._settings.get_boolean('private-mode');
        this._clipboardChangeTimeout = null;
        this._pendingImageCapture = null;
        this._pendingImageTimeout = null;
        this._lastImageTimestamp = 0;
        
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
        this._updateIndicatorDisplay();
    }
    
    _updateIndicatorDisplay() {
        if (!this._box) return;
        const mode = this._settings.get_string('top-bar-display') || 'icon';
        this._indicatorIcon.visible = (mode === 'icon' || mode === 'both');
        this._indicatorLabel.visible = (mode === 'text' || mode === 'both');
        this.visible = (mode !== 'none');
    }
    
    // Override to capture cursor position when panel button is clicked
    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS ||
            event.type() === Clutter.EventType.TOUCH_BEGIN) {
            // Capture cursor position before menu opens
            const [pointerX, pointerY] = global.get_pointer();
            this._savedCursorX = pointerX;
            this._savedCursorY = pointerY;
        }
        return super.vfunc_event(event);
    }
    
    _overrideMenuPositioning() {
        // Connect to open-state-changed to position AFTER menu opens
        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen && this._settings.get_string('popup-position') === 'cursor') {
                // Use idle_add to ensure we run after BoxPointer's positioning
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._repositionAtCursor();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    }
    
    _repositionAtCursor() {
        const monitor = Main.layoutManager.currentMonitor;
        if (!monitor) return;

        // Use saved cursor position (captured at toggle time)
        const pointerX = this._savedCursorX;
        const pointerY = this._savedCursorY;

        const boxPointer = this.menu._boxPointer;
        const menuActor = boxPointer?.actor || boxPointer || this.menu.actor;
        
        if (!menuActor) return;

        // Get menu dimensions
        const menuWidth = this._settings.get_int('window-width') || 400;
        const menuHeight = this._settings.get_int('window-height') || 500;

        // Calculate position - place menu near cursor
        let x = Math.floor(pointerX);
        let y = Math.floor(pointerY);

        // Adjust if menu would overflow right edge
        if (x + menuWidth > monitor.x + monitor.width) {
            x = monitor.x + monitor.width - menuWidth - POPUP_EDGE_MARGIN;
        }

        // Adjust if menu would overflow bottom edge
        if (y + menuHeight > monitor.y + monitor.height) {
            y = monitor.y + monitor.height - menuHeight - POPUP_EDGE_MARGIN;
        }

        // Ensure menu stays within monitor bounds
        x = Math.max(monitor.x + POPUP_EDGE_MARGIN, x);
        y = Math.max(monitor.y + POPUP_EDGE_MARGIN, y);

        // Set position directly on the actor
        menuActor.set_position(x, y);

        // Hide the arrow/border since we're not anchored to anything
        if (boxPointer && boxPointer._border) {
            boxPointer._border.hide();
        }
        if (boxPointer && boxPointer._arrow) {
            boxPointer._arrow.hide();
        }
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
            text: _('Clipboard'),
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
                if (this._itemsBox.get_n_children() > 0) {
                    const firstItem = this._itemsBox.get_child_at_index(0);
                    if (firstItem && firstItem.can_focus) {
                        firstItem.grab_key_focus();
                        return Clutter.EVENT_STOP;
                    }
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
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._onMenuOpened();
            }
        });

        this.menu.actor.connect('key-press-event', (actor, event) => {
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
                    this._searchEntry.grab_key_focus();
                    return Clutter.EVENT_STOP;
                }
            }

            if (symbol === Clutter.KEY_slash) {
                if (this._searchEntry) {
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
        
        this._clipboard = St.Clipboard.get_default();
        this._selection = Shell.Global.get().get_display().get_selection();
        
        this._ownerChangedId = this._selection.connect('owner-changed', 
            (selection, selectionType) => {
                if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
                    this._onClipboardChanged();
                }
            });
        
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
        if (this._privateMode) return;
        
        if (this._debouncing > 0) {
            this._debouncing--;
            return;
        }
        
        // Add a small delay to coalesce rapid clipboard changes (e.g., from screenshot tools)
        if (this._clipboardChangeTimeout) {
            GLib.source_remove(this._clipboardChangeTimeout);
            this._clipboardChangeTimeout = null;
        }
        
        this._clipboardChangeTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._clipboardChangeTimeout = null;
            this._queryClipboard();
            this._focusTimeout = null;
            return GLib.SOURCE_REMOVE;
        });
    }
    
    _queryClipboard() {
        if (this._settings.get_boolean('enable-images')) {
            this._clipboard.get_content(
                CLIPBOARD_TYPE,
                'image/png',
                (clipboard, bytes) => {
                    if (bytes && bytes.get_size() > 0) {
                        const imageData = bytes.get_data();
                        if (this._settings.get_boolean('has-text-extractor-extension') &&
                            this._hasRecentTextExtractorScreenshotSignal()) {
                            this._schedulePendingImageCapture(imageData);
                        } else {
                            this._processImageContent(imageData);
                        }
                    } else {
                        this._queryTextClipboard();
                    }
                }
            );
        } else {
            this._queryTextClipboard();
        }
    }
    
    _queryTextClipboard() {
        const preserveFormatting = this._settings.get_boolean('preserve-formatting');
        
        if (preserveFormatting) {
            this._clipboard.get_content(
                CLIPBOARD_TYPE,
                'text/html',
                (clipboard, bytes) => {
                    const richText = bytes && bytes.get_size() > 0 
                        ? new TextDecoder().decode(bytes.get_data())
                        : null;
                    
                    this._clipboard.get_text(CLIPBOARD_TYPE, (clipboard, text) => {
                        if (text) {
                            this._processTextContent(text, richText);
                        }
                    });
                }
            );
        } else {
            this._clipboard.get_text(CLIPBOARD_TYPE, (clipboard, text) => {
                if (text) {
                    this._processTextContent(text, null);
                }
            });
        }
    }
    
    _processTextContent(plainText, richText) {
        if (!plainText || plainText.length === 0) return;

        this._maybeSuppressPendingImageForOcrText(plainText);
        
        if (this._settings.get_boolean('strip-whitespace')) {
            plainText = plainText.trim();
        }
        
        if (this._settings.get_boolean('ignore-passwords') && this._isSensitiveContent(plainText)) {
            return;
        }
        
        if (this._settings.get_boolean('deduplicate')) {
            const hash = this._computeHash(plainText);
            const existing = this._history.findDuplicate(hash);
            
            if (existing && existing.plain === plainText) {
                if (this._settings.get_boolean('move-item-first')) {
                    this._history.moveToFront(existing);
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
        
        for (const pattern of SENSITIVE_PATTERNS) {
            if (pattern.test(text)) return true;
        }
        
        if (text.length >= 12 && text.length <= 128 && !text.includes(' ')) {
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
    
    _processImageContent(imageData) {
        const maxSize = this._settings.get_int('max-image-size') * 1024 * 1024;
        const imageSize = getByteLength(imageData);

        if (!imageData || imageSize === 0) return;
        if (imageSize > maxSize) return;
        
        // Check for duplicate images
        if (this._settings.get_boolean('deduplicate')) {
            let hash = imageSize;
            if (hash > 200) {
                hash += imageData[0] + imageData[Math.floor(hash/2)] + imageData[hash-1];
            }
            const existing = this._history.findDuplicate(hash);
            
            if (existing && existing.type === 'image' && existing.imageData && 
                getByteLength(existing.imageData) === imageSize) {
                // Likely duplicate - move to front if enabled
                if (this._settings.get_boolean('move-item-first')) {
                    this._history.moveToFront(existing);
                    this._refreshMenu();
                }
                return;
            }
        }
        
        const entry = new ClipboardEntry(
            this._store.getNextId(),
            'image',
            imageData
        );
        
        this._addEntry(entry);
    }

    _schedulePendingImageCapture(imageData) {
        if (!imageData || imageData.length === 0) {
            return;
        }

        if (this._pendingImageCapture?.imageData) {
            this._processImageContent(this._pendingImageCapture.imageData);
            this._clearPendingImageCapture();
        }

        const createdAt = Date.now();
        this._pendingImageCapture = { imageData, createdAt };
        this._lastImageTimestamp = createdAt;

        this._pendingImageTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OCR_IMAGE_HOLD_MS, () => {
            const pending = this._pendingImageCapture;
            this._pendingImageTimeout = null;
            this._pendingImageCapture = null;

            if (pending?.imageData) {
                this._processImageContent(pending.imageData);
            }

            this._focusTimeout = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearPendingImageCapture() {
        if (this._pendingImageTimeout) {
            GLib.source_remove(this._pendingImageTimeout);
            this._pendingImageTimeout = null;
        }

        this._pendingImageCapture = null;
    }

    _hasRecentTextExtractorScreenshotSignal() {
        try {
            const dir = Gio.File.new_for_path(TEXT_EXTRACTOR_SCREENSHOT_DIR);
            if (!dir.query_exists(null)) {
                return false;
            }

            const enumerator = dir.enumerate_children(
                'standard::name,time::modified',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let newestModifiedSec = 0;
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const modifiedSec = info.get_attribute_uint64('time::modified');
                if (modifiedSec > newestModifiedSec) {
                    newestModifiedSec = modifiedSec;
                }
            }

            const nowSec = Math.floor(Date.now() / 1000);
            return newestModifiedSec > 0 && (nowSec - newestModifiedSec) <= 5;
        } catch (e) {
            return false;
        }
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
            return;
        }

        const normalized = plainText.trim();
        const hasLikelyOcrText = normalized.length >= OCR_MIN_TEXT_LENGTH && /\s/.test(normalized);
        const hasScreenshotSignal = this._hasRecentTextExtractorScreenshotSignal();

        if (hasLikelyOcrText || hasScreenshotSignal) {
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
        
        if (this._store.getCacheSize) {
           const quotaMB = this._settings.get_int('cache-size') || 100;
           if (this._store.getCacheSize() > quotaMB * 1024 * 1024) {
               current = this._history.last;
               while (current && this._store.getCacheSize() > quotaMB * 1024 * 1024) {
                   const prev = current.prev;
                   if (!current.pinned) {
                       this._history.remove(current);
                       this._store.deleteEntry(current);
                   }
                   current = prev;
               }
           }
        }
    }
    
    _selectEntry(entry) {
        this._debouncing++;
        
        if (entry.type === 'text') {
            if (entry.rich && !this._settings.get_boolean('prefer-plain-text')) {
                this._clipboard.set_content(
                    CLIPBOARD_TYPE,
                    'text/html',
                    toGBytes(new TextEncoder().encode(entry.rich))
                );
            }
            this._clipboard.set_text(CLIPBOARD_TYPE, entry.plain || '');
        } else if (entry.type === 'image') {
            this._clipboard.set_content(
                CLIPBOARD_TYPE,
                'image/png',
                toGBytes(entry.imageData)
            );
        }
        
        if (this._settings.get_boolean('move-item-first') && !entry.pinned) {
            this._history.moveToFront(entry);
        }
        
        this._updateSelection(entry);
        
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
        
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            keyboard.notify_keyval(Clutter.get_current_event_time(), Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            keyboard.notify_keyval(Clutter.get_current_event_time(), Clutter.KEY_v, Clutter.KeyState.PRESSED);
            keyboard.notify_keyval(Clutter.get_current_event_time(), Clutter.KEY_v, Clutter.KeyState.RELEASED);
            keyboard.notify_keyval(Clutter.get_current_event_time(), Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
            this._focusTimeout = null;
            return GLib.SOURCE_REMOVE;
        });
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
        
        this._store.updatePinStatus(entry, entry.pinned);
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
        if (this._focusTimeout) {
            GLib.source_remove(this._focusTimeout);
        }
        this._focusTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (this._searchEntry) {
                this._searchEntry.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            }

            if (this._itemsBox.get_n_children() > 0) {
                const firstItem = this._itemsBox.get_child_at_index(0);
                if (firstItem && firstItem.can_focus) {
                    firstItem.grab_key_focus();
                }
            }
            this._focusTimeout = null;
            return GLib.SOURCE_REMOVE;
        });
    }
    
    _onSearchChanged() {
        if (!this._searchEntry) {
            return;
        }

        const query = this._searchEntry.get_text();
        const queryLower = query.toLowerCase();
        
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
            if (this._matchesSearch(current, queryLower)) {
                results.push(current);
            }
            current = current.next;
        }
        
        // Then history
        current = this._history.first;
        while (current) {
            if (this._matchesSearch(current, queryLower)) {
                results.push(current);
            }
            current = current.next;
        }
        
        this._searchResults = results;
        this._refreshMenu();
    }
    
    _matchesSearch(entry, query) {
        if (entry.type === 'image') return false;

        const text = (entry.plain || '').toLowerCase();

        return text.includes(query);
    }
    
    _refreshMenu() {
        if (this._animTimeouts) {
            for (const id of this._animTimeouts) GLib.source_remove(id);
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
        if (!this._animTimeouts) this._animTimeouts = [];
        item.opacity = 0;
        item.translation_y = 8;
        const delay = Math.min(index * 15, 150);
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            item.ease({
                opacity: 255,
                translation_y: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            this._animTimeouts = this._animTimeouts.filter(id => id !== timeoutId);
            return GLib.SOURCE_REMOVE;
        });
        this._animTimeouts.push(timeoutId);
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
        } else {
            this._privateButton.remove_style_class_name('clipo-private-active');
        }
    }
    
    _openSettings() {
        this.menu.close();
        this._extension.openPreferences();
    }
    
    destroy() {
        if (this._cursorAnchor) {
            this._cursorAnchor.destroy();
            this._cursorAnchor = null;
        }

        if (this._clipboardChangeTimeout) {
            GLib.source_remove(this._clipboardChangeTimeout);
            this._clipboardChangeTimeout = null;
        }

        this._clearPendingImageCapture();

        if (this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
        }
        
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
        }
        
        this._unregisterKeybindings();
        
        super.destroy();
    }
});

/**
 * Extension Entry Point
 */
export default class ClipoExtension extends Extension {
    enable() {
        this._indicator = new ClipboardIndicator(this);
        Main.panel.addToStatusArea('clipo', this._indicator);
    }
    
    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}

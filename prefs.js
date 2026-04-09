/**
 * Clipo - Preferences
 * Settings UI for the clipboard manager
 */

import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * Keybinding Widget
 */
const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    _init(settings, key, title, subtitle) {
        super._init({
            title: title,
            subtitle: subtitle || '',
        });
        
        this._settings = settings;
        this._key = key;
        
        // Shortcut label
        this._shortcutLabel = new Gtk.ShortcutLabel({
            accelerator: this._getAccelerator(),
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._shortcutLabel);
        
        // Edit button
        this._editButton = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._editButton.connect('clicked', this._onEditClicked.bind(this));
        this.add_suffix(this._editButton);
        
        // Clear button
        this._clearButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._clearButton.connect('clicked', this._onClearClicked.bind(this));
        this.add_suffix(this._clearButton);
        
        // Listen for settings changes
        this._settings.connect(`changed::${key}`, () => {
            this._shortcutLabel.accelerator = this._getAccelerator();
        });
    }
    
    _getAccelerator() {
        const value = this._settings.get_strv(this._key);
        return value.length > 0 ? value[0] : '';
    }
    
    _onEditClicked() {
        const dialog = new ShortcutDialog(this.get_root(), this._key);
        dialog.connect('response', (dlg, response) => {
            if (response === Gtk.ResponseType.OK) {
                const accelerator = dialog.getAccelerator();
                if (accelerator) {
                    this._settings.set_strv(this._key, [accelerator]);
                }
            }
            dialog.destroy();
        });
        dialog.present();
    }
    
    _onClearClicked() {
        this._settings.set_strv(this._key, []);
    }
});

/**
 * Shortcut capture dialog
 */
const ShortcutDialog = GObject.registerClass(
class ShortcutDialog extends Gtk.Dialog {
    _init(parent, key) {
        super._init({
            title: _('Set Shortcut'),
            transient_for: parent,
            modal: true,
            use_header_bar: true,
        });
        
        this._accelerator = '';
        
        this.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        this.add_button(_('Set'), Gtk.ResponseType.OK);
        
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 20,
            margin_top: 20,
            margin_bottom: 20,
            margin_start: 20,
            margin_end: 20,
        });
        
        const label = new Gtk.Label({
            label: _('Press a key combination...'),
            css_classes: ['title-2'],
        });
        box.append(label);
        
        this._shortcutLabel = new Gtk.ShortcutLabel({
            accelerator: '',
            halign: Gtk.Align.CENTER,
        });
        box.append(this._shortcutLabel);
        
        this.get_content_area().append(box);
        
        // Capture key events
        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', this._onKeyPressed.bind(this));
        this.add_controller(controller);
    }
    
    _onKeyPressed(controller, keyval, keycode, state) {
        // Filter out modifier-only keys
        const forbiddenKeys = [
            Gtk.KEY_Shift_L, Gtk.KEY_Shift_R,
            Gtk.KEY_Control_L, Gtk.KEY_Control_R,
            Gtk.KEY_Alt_L, Gtk.KEY_Alt_R,
            Gtk.KEY_Super_L, Gtk.KEY_Super_R,
            Gtk.KEY_Meta_L, Gtk.KEY_Meta_R,
        ];
        
        if (forbiddenKeys.includes(keyval)) {
            return false;
        }
        
        // Build accelerator string
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        this._accelerator = Gtk.accelerator_name(keyval, mods);
        this._shortcutLabel.accelerator = this._accelerator;
        
        return true;
    }
    
    getAccelerator() {
        return this._accelerator;
    }
});

/**
 * Main Preferences Window
 */
export default class ClipoPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        
        window.set_default_size(600, 700);
        
        // General Page
        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);
        
        // History Group
        const historyGroup = new Adw.PreferencesGroup({
            title: _('History'),
            description: _('Configure clipboard history behavior'),
        });
        generalPage.add(historyGroup);
        
        // History size
        const historySizeRow = new Adw.SpinRow({
            title: _('History Size'),
            subtitle: _('Maximum number of items to keep'),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 1000,
                step_increment: 10,
                page_increment: 50,
            }),
        });
        settings.bind('history-size', historySizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(historySizeRow);
        
        // Cache size
        const cacheSizeRow = new Adw.SpinRow({
            title: _('Cache Size (MB)'),
            subtitle: _('Maximum disk space for clipboard cache'),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 500,
                step_increment: 10,
                page_increment: 50,
            }),
        });
        settings.bind('cache-size', cacheSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(cacheSizeRow);
        
        // Behavior Group
        const behaviorGroup = new Adw.PreferencesGroup({
            title: _('Behavior'),
        });
        generalPage.add(behaviorGroup);
        
        // Move item to top
        const moveFirstRow = new Adw.SwitchRow({
            title: _('Move Selected to Top'),
            subtitle: _('Move selected item to the top of history'),
        });
        settings.bind('move-item-first', moveFirstRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(moveFirstRow);
        
        // Close on select
        const closeOnSelectRow = new Adw.SwitchRow({
            title: _('Close on Selection'),
            subtitle: _('Close menu after selecting an item'),
        });
        settings.bind('close-on-select', closeOnSelectRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(closeOnSelectRow);
        
        // Paste on select
        const pasteOnSelectRow = new Adw.SwitchRow({
            title: _('Auto-Paste'),
            subtitle: _('Automatically paste after selecting an item'),
        });
        settings.bind('paste-on-select', pasteOnSelectRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(pasteOnSelectRow);
        
        // Strip whitespace
        const stripWhitespaceRow = new Adw.SwitchRow({
            title: _('Strip Whitespace'),
            subtitle: _('Remove leading/trailing whitespace'),
        });
        settings.bind('strip-whitespace', stripWhitespaceRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(stripWhitespaceRow);
        
        // Deduplicate
        const deduplicateRow = new Adw.SwitchRow({
            title: _('Remove Duplicates'),
            subtitle: _('Remove consecutive identical entries'),
        });
        settings.bind('deduplicate', deduplicateRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(deduplicateRow);
        
        // Content Page
        const contentPage = new Adw.PreferencesPage({
            title: _('Content'),
            icon_name: 'edit-paste-symbolic',
        });
        window.add(contentPage);
        
        // Text Group
        const textGroup = new Adw.PreferencesGroup({
            title: _('Text'),
            description: _('Text handling options'),
        });
        contentPage.add(textGroup);
        
        // Preserve formatting
        const preserveFormattingRow = new Adw.SwitchRow({
            title: _('Preserve Formatting'),
            subtitle: _('Store rich text formatting (HTML/RTF)'),
        });
        settings.bind('preserve-formatting', preserveFormattingRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        textGroup.add(preserveFormattingRow);
        
        // Prefer plain text
        const preferPlainRow = new Adw.SwitchRow({
            title: _('Prefer Plain Text'),
            subtitle: _('Always paste as plain text by default'),
        });
        settings.bind('prefer-plain-text', preferPlainRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        textGroup.add(preferPlainRow);
        
        // Images Group
        const imagesGroup = new Adw.PreferencesGroup({
            title: _('Images'),
            description: _('Image capture settings'),
        });
        contentPage.add(imagesGroup);
        
        // Enable images
        const enableImagesRow = new Adw.SwitchRow({
            title: _('Enable Image Capture'),
            subtitle: _('Capture images copied to clipboard'),
        });
        settings.bind('enable-images', enableImagesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        imagesGroup.add(enableImagesRow);
        
        // Show thumbnails
        const showThumbnailsRow = new Adw.SwitchRow({
            title: _('Show Thumbnails'),
            subtitle: _('Display image thumbnails in the menu'),
        });
        settings.bind('show-thumbnails', showThumbnailsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        imagesGroup.add(showThumbnailsRow);

        // Text Extractor integration
        const textExtractorIntegrationRow = new Adw.ActionRow({
            title: _('Text Extractor Integration'),
            subtitle: _('Ignore temporary screenshots created by the Text Extractor extension'),
        });

        const textExtractorLink = new Gtk.LinkButton({
            uri: 'https://extensions.gnome.org/extension/8912/text-extractor/',
            label: _('Get Extension'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });

        const textExtractorSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
        });

        textExtractorIntegrationRow.add_suffix(textExtractorLink);
        textExtractorIntegrationRow.add_suffix(textExtractorSwitch);
        textExtractorIntegrationRow.activatable_widget = textExtractorSwitch;

        settings.bind('has-text-extractor-extension', textExtractorSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        imagesGroup.add(textExtractorIntegrationRow);
        
        // Max image size
        const maxImageSizeRow = new Adw.SpinRow({
            title: _('Max Image Size (MB)'),
            subtitle: _('Skip images larger than this'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 10,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        settings.bind('max-image-size', maxImageSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        imagesGroup.add(maxImageSizeRow);
        
        // Appearance Page
        const appearancePage = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(appearancePage);
        
        // Indicator Group
        const indicatorGroup = new Adw.PreferencesGroup({
            title: _('Panel Indicator'),
        });
        appearancePage.add(indicatorGroup);
        
        // Display mode
        const displayModeRow = new Adw.ComboRow({
            title: _('Display Mode'),
            subtitle: _('What to show in the top bar'),
        });
        displayModeRow.set_model(new Gtk.StringList({
            strings: [_('Icon Only'), _('Text Only'), _('Icon and Text'), _('Hidden')],
        }));
        
        const displayModes = ['icon', 'text', 'both', 'none'];
        const currentMode = settings.get_string('top-bar-display');
        displayModeRow.set_selected(displayModes.indexOf(currentMode));
        
        displayModeRow.connect('notify::selected', () => {
            settings.set_string('top-bar-display', displayModes[displayModeRow.selected]);
        });
        indicatorGroup.add(displayModeRow);
        
        // Popup Group
        const popupGroup = new Adw.PreferencesGroup({
            title: _('Popup'),
        });
        appearancePage.add(popupGroup);
        
        // Popup position
        const popupPositionRow = new Adw.ComboRow({
            title: _('Popup Position'),
            subtitle: _('Where to show the clipboard popup'),
        });
        popupPositionRow.set_model(new Gtk.StringList({
            strings: [_('Near Cursor'), _('Center Screen')],
        }));
        
        const positions = ['cursor', 'center'];
        const currentPos = settings.get_string('popup-position');
        popupPositionRow.set_selected(positions.indexOf(currentPos));
        
        popupPositionRow.connect('notify::selected', () => {
            settings.set_string('popup-position', positions[popupPositionRow.selected]);
        });
        popupGroup.add(popupPositionRow);
        
        // Preview lines
        const previewLinesRow = new Adw.SpinRow({
            title: _('Preview Lines'),
            subtitle: _('Number of lines to show in item preview'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 5,
                step_increment: 1,
                page_increment: 1,
            }),
        });
        settings.bind('preview-lines', previewLinesRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        popupGroup.add(previewLinesRow);
        
        // Window width
        const windowWidthRow = new Adw.SpinRow({
            title: _('Window Width'),
            subtitle: _('Width of the popup in pixels'),
            adjustment: new Gtk.Adjustment({
                lower: 300,
                upper: 800,
                step_increment: 50,
                page_increment: 100,
            }),
        });
        settings.bind('window-width', windowWidthRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        popupGroup.add(windowWidthRow);

        const windowHeightRow = new Adw.SpinRow({
            title: _('Window Height'),
            subtitle: _('Maximum height of the popup in pixels'),
            adjustment: new Gtk.Adjustment({
                lower: 300,
                upper: 900,
                step_increment: 50,
                page_increment: 100,
            }),
        });
        settings.bind('window-height', windowHeightRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        popupGroup.add(windowHeightRow);
        
        // Shortcuts Page
        const shortcutsPage = new Adw.PreferencesPage({
            title: _('Shortcuts'),
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
        });
        window.add(shortcutsPage);
        
        // Shortcuts Group
        const shortcutsGroup = new Adw.PreferencesGroup({
            title: _('Keyboard Shortcuts'),
            description: _('Configure global keyboard shortcuts'),
        });
        shortcutsPage.add(shortcutsGroup);
        
        // Toggle menu shortcut
        const toggleMenuRow = new ShortcutRow(
            settings,
            'toggle-menu',
            _('Toggle Clipboard Menu'),
            _('Open or close the clipboard popup')
        );
        shortcutsGroup.add(toggleMenuRow);
        
        // Clear history shortcut
        const clearHistoryRow = new ShortcutRow(
            settings,
            'clear-history',
            _('Clear History'),
            _('Clear all non-pinned clipboard items')
        );
        shortcutsGroup.add(clearHistoryRow);
        
        // Toggle private shortcut
        const togglePrivateRow = new ShortcutRow(
            settings,
            'toggle-private',
            _('Toggle Private Mode'),
            _('Pause/resume clipboard monitoring')
        );
        shortcutsGroup.add(togglePrivateRow);
        
        // Privacy Page
        const privacyPage = new Adw.PreferencesPage({
            title: _('Privacy'),
            icon_name: 'security-high-symbolic',
        });
        window.add(privacyPage);
        
        // Privacy Group
        const privacyGroup = new Adw.PreferencesGroup({
            title: _('Privacy Settings'),
        });
        privacyPage.add(privacyGroup);
        
        // Private mode
        const privateModeRow = new Adw.SwitchRow({
            title: _('Private Mode'),
            subtitle: _('Stop recording clipboard changes'),
        });
        settings.bind('private-mode', privateModeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        privacyGroup.add(privateModeRow);
        
        // Ignore passwords
        const ignorePasswordsRow = new Adw.SwitchRow({
            title: _('Ignore Password Fields'),
            subtitle: _('Do not capture clipboard from password managers'),
        });
        settings.bind('ignore-passwords', ignorePasswordsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        privacyGroup.add(ignorePasswordsRow);
        
        // Persistence Group
        const persistenceGroup = new Adw.PreferencesGroup({
            title: _('Persistence'),
        });
        privacyPage.add(persistenceGroup);
        
        // Persist history
        const persistHistoryRow = new Adw.SwitchRow({
            title: _('Save History to Disk'),
            subtitle: _('Remember clipboard history between sessions'),
        });
        settings.bind('persist-history', persistHistoryRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        persistenceGroup.add(persistHistoryRow);
        
        // Save only pinned
        const saveOnlyPinnedRow = new Adw.SwitchRow({
            title: _('Save Only Pinned Items'),
            subtitle: _('Non-pinned items are lost on restart'),
        });
        settings.bind('save-only-pinned', saveOnlyPinnedRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        persistenceGroup.add(saveOnlyPinnedRow);
    }
}

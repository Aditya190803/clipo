# Clipo

A lightweight, fast, keyboard-driven clipboard manager for GNOME Shell.

## Features

- **Clipboard History Tracking** - Automatically captures text and images
- **Rich Text Preservation** - Maintains formatting (bold, links, lists)
- **Image Support** - Captures and displays image thumbnails
- **Pinning** - Pin important items to keep them at the top
- **Fast Search** - Real-time case-insensitive search with **regex support** and **match highlighting**
- **Keyboard Shortcuts** - Quick access with `Super+V`
- **Private Mode** - Temporarily pause clipboard monitoring
- **Persistence** - History survives restarts
- **Sensitive Content Detection** - Automatically skips passwords, API keys, and secrets
- **Confirmation Dialogs** - Prevent accidental data loss
- **Modern UI** - Clean, responsive design with proper cursor positioning

## Installation

### Prerequisites

- GNOME Shell 45+
- Wayland or X11 session
- `glib-compile-schemas` (usually pre-installed)

### Quick Install

```bash
cd /home/adi/Projects/clipo
make install
```

### Manual Install

```bash
# Copy files to extension directory
mkdir -p ~/.local/share/gnome-shell/extensions/clipo@Aditya190803
cp -r metadata.json extension.js prefs.js dataStructures.js store.js stylesheet.css schemas ~/.local/share/gnome-shell/extensions/clipo@Aditya190803/

# Compile schemas
glib-compile-schemas ~/.local/share/gnome-shell/extensions/clipo@Aditya190803/schemas/
```

## Enabling the Extension

### Step 1: Restart GNOME Shell

**X11/Xorg:**
1. Press `Alt+F2`
2. Type `r`
3. Press `Enter`

**Wayland:**
1. Log out from your session
2. Log back in

### Step 2: Enable the Extension

Choose one method:

**Option A - Command Line:**
```bash
gnome-extensions enable clipo@Aditya190803
```

**Option B - GNOME Extensions App:**
1. Open "Extensions" app
2. Find "Clipo" in the list
3. Toggle the switch to enable

**Option C - Extension Manager:**
1. Install GNOME Extensions (or Extension Manager)
2. Search for "Clipo"
3. Enable it

**Option D - Using Makefile:**
```bash
make enable
```

## Usage

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Super+V` | Toggle clipboard menu |
| `Super+Shift+C` | Clear history |
| `Super+Shift+P` | Toggle private mode |

### In the Menu

| Action | Method |
|--------|--------|
| **Search** | Type to filter clipboard history |
| **Pin Item** | Click the ⭐ star icon |
| **Delete Item** | Click the 🗑️ trash icon |
| **Clear All** | Click the trash button in the action bar |
| **Settings** | Click the ⚙️ gear icon |
| **Toggle Private Mode** | Click the 🛡️ shield icon |
| **Navigate Pages** | Click arrow buttons or use page numbers |

### Search Features

- **Case-insensitive** substring matching
- **Regex support** for advanced searches (try `^test.*$`)
- **Live highlighting** - matching text is highlighted in blue
- **Search across** text items (images not searchable)

## Configuration

### Access Settings

1. Click the ⚙️ settings icon in the clipboard menu
2. Or open GNOME Settings → Extensions → Clipo

### Options

#### History
- **History Size**: Maximum items to keep (10-1000, default 50)
- **Deduplicate**: Remove consecutive identical items (default: ON)
- **Move Selected to Top**: Reorder on selection (default: ON)

#### Rich Text
- **Preserve Formatting**: Store HTML/RTF formatting (default: ON)
- **Prefer Plain Text**: Always paste as plain text (default: OFF)

#### Images
- **Enable Images**: Capture images to clipboard (default: ON)
- **Max Image Size**: Maximum size per image in MB (default: 2MB)
- **Show Thumbnails**: Display image previews (default: ON)

#### Security & Privacy
- **Private Mode**: Pause monitoring and don't record (default: OFF)
- **Ignore Passwords**: Skip sensitive content (passwords, API keys, tokens) (default: ON)
- **Save Only Pinned**: Only persist pinned items to disk (default: OFF)

#### UI
- **Top Bar Display**: Show "icon", "text", "both", or "none" (default: icon)
- **Popup Position**: Show menu at "cursor" or "center" (default: cursor)
- **Window Width**: Menu width in pixels (default: 400px)
- **Window Height**: Menu max height in pixels (default: 500px)
- **Preview Lines**: Lines of text to show per item (default: 2)

#### Persistence
- **Persist History**: Save history to disk (default: ON)
- **Cache Size**: Maximum disk space for history in MB (default: 50MB)

## Features in Detail

### Search with Highlighting
When you type in the search box, Clipo will:
1. Filter items in real-time
2. Show only matching items
3. **Highlight the matching text in blue**
4. Support regex patterns for power users

Example searches:
- `test` - find items containing "test"
- `^error` - find items starting with "error"
- `\.js$` - find items ending with ".js"

### Sensitive Content Detection
Clipo automatically detects and skips:
- Passwords (`password=...`)
- API Keys (`api_key: ...`)
- AWS Keys (`AKIA...`)
- Private SSH/PGP keys
- GitHub/GitLab tokens
- High-entropy strings (potential secrets)

You can disable this in Settings if needed.

### Confirmation Dialog
When clearing history, Clipo shows a confirmation dialog to prevent accidental loss of data.

## Troubleshooting

### Extension doesn't appear after installation

1. **Check if installed correctly:**
   ```bash
   ls ~/.local/share/gnome-shell/extensions/clipo@Aditya190803/
   ```

2. **Verify schemas compiled:**
   ```bash
   ls -la ~/.local/share/gnome-shell/extensions/clipo@Aditya190803/schemas/gschemas.compiled
   ```

3. **Restart GNOME Shell:**
   - X11: `Alt+F2` → `r` → Enter
   - Wayland: Log out and back in

### Extension crashes or doesn't work

1. **View extension logs:**
   ```bash
   make logs
   # or
   journalctl -f | grep -i clipo
   ```

2. **Check for errors:**
   - Look for red X icon in top-right
   - Click it to see error details

3. **Disable and re-enable:**
   ```bash
   gnome-extensions disable clipo@Aditya190803
   gnome-extensions enable clipo@Aditya190803
   ```

### Search not working

- Make sure you're searching in text items (images aren't searchable)
- For regex searches, ensure the pattern is valid
- Clear search box and try simple substring match

### Private mode issues

- Private mode pauses recording temporarily
- Existing history is not cleared
- Re-enable monitoring by toggling again

## Development

### Watch Mode (Auto-reload)
```bash
make dev
```
Watches for file changes and auto-reinstalls. Restart GNOME Shell to see changes.

### View Logs
```bash
make logs
```
Shows real-time extension logs with errors and debug info.

### Test in Nested Shell
```bash
make debug
```
Runs GNOME Shell in a window for testing without restarting.

### Pack for Distribution
```bash
make pack
```
Creates `dist/clipo@Aditya190803.zip` for uploading to extensions.gnome.org.

### Clean Build
```bash
make clean
```
Removes compiled schemas and build artifacts.

## Requirements

- **GNOME Shell**: 45+ (tested on 45, 46, 47, 48)
- **Session Type**: X11 or Wayland
- **Arch/Distro**: Any GNOME-based Linux (Fedora, Ubuntu, Debian, Arch, etc.)

## License

MIT License - see [LICENSE](LICENSE) file.

## Credits

Inspired by [GNOME Clipboard History](https://github.com/SUPERCILEX/gnome-clipboard-history).

Built with ❤️ by [Aditya190803](https://github.com/Aditya190803).

## Support & Issues

Found a bug or have a feature request?

- 🐛 [Report issues](https://github.com/Aditya190803/clipo/issues)
- 💡 [Suggest features](https://github.com/Aditya190803/clipo/issues)
- 📝 [Check discussions](https://github.com/Aditya190803/clipo/discussions)

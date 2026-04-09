# Clipo Makefile
# Build and installation commands for GNOME Shell clipboard manager

UUID = clipo@Aditya190803
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all build install uninstall clean schemas enable disable restart pack dev logs debug help

all: build

build: schemas

schemas:
	glib-compile-schemas schemas/

install: build
	@echo "Installing Clipo extension..."
	mkdir -p $(EXTENSION_DIR)
	cp -r metadata.json extension.js prefs.js dataStructures.js store.js stylesheet.css schemas $(EXTENSION_DIR)/
	@echo ""
	@echo "========================================"
	@echo "  Clipo installed successfully!"
	@echo "========================================"
	@echo ""
	@echo "Extension installed to: $(EXTENSION_DIR)"
	@echo ""
	@echo "To enable the extension:"
	@echo ""
	@echo "  1. RESTART GNOME SHELL:"
	@echo ""
	@echo "     - X11/Xorg:  Press Alt+F2, type 'r', press Enter"
	@echo ""
	@echo "     - Wayland:   Log out and log back in"
	@echo "                  (GNOME Shell cannot be restarted on Wayland)"
	@echo ""
	@echo "  2. ENABLE THE EXTENSION (choose one):"
	@echo ""
	@echo "     Option A - Command line:"
	@echo "       gnome-extensions enable $(UUID)"
	@echo ""
	@echo "     Option B - GNOME Extensions app:"
	@echo "       Open 'Extensions' app and toggle Clipo on"
	@echo ""
	@echo "     Option C - Extension Manager (if installed):"
	@echo "       Search for 'Clipo' and enable"
	@echo ""
	@echo "  Or just run: make enable"
	@echo ""
	@echo "Default shortcut: Super+V (open clipboard menu)"
	@echo ""
	@echo "Other shortcuts:"
	@echo "  Super+Shift+C  - Clear history"
	@echo "  Super+Shift+P  - Toggle private mode"
	@echo ""

uninstall:
	rm -rf $(EXTENSION_DIR)
	@echo "Extension uninstalled"
	@echo ""
	@echo "To complete removal, restart GNOME Shell:"
	@echo "  - X11:     Alt+F2 → 'r' → Enter"
	@echo "  - Wayland: Log out and log back in"

clean:
	rm -f schemas/gschemas.compiled

enable:
	@echo "Enabling Clipo extension..."
	gnome-extensions enable $(UUID)
	@echo "Done! The extension should now be active."

disable:
	gnome-extensions disable $(UUID)
	@echo "Clipo disabled"

restart:
	@echo ""
	@echo "How to restart GNOME Shell:"
	@echo ""
	@echo "  X11/Xorg:"
	@echo "    Press Alt+F2, type 'r', press Enter"
	@echo ""
	@echo "  Wayland:"
	@echo "    Log out and log back in"
	@echo "    (Hot restart is not supported on Wayland)"
	@echo ""
	@echo "Check which session type you're using:"
	@echo "  echo \$$XDG_SESSION_TYPE"
	@echo ""

pack: build
	mkdir -p dist
	rm -f dist/$(UUID).zip
	zip -r dist/$(UUID).zip metadata.json extension.js prefs.js dataStructures.js store.js stylesheet.css schemas/ -x "schemas/gschemas.compiled"
	@echo "Extension packed to dist/$(UUID).zip"
	@echo "Ready for upload to extensions.gnome.org"

dev: install
	@echo "Development mode: Watching for changes... (Ctrl+C to stop)"
	@echo ""
	@while true; do \
		inotifywait -qr -e modify -e create -e delete --exclude '\.git' .; \
		make install; \
		echo ""; \
		echo "Reinstalled at $$(date '+%H:%M:%S')"; \
		echo "Restart GNOME Shell to apply changes."; \
		echo ""; \
	done

logs:
	@echo "Showing Clipo logs (Ctrl+C to stop)..."
	@echo ""
	journalctl -f -o cat /usr/bin/gnome-shell 2>/dev/null | grep -i clipo || \
	journalctl -f -o cat GNOME_SHELL_EXTENSION_UUID=$(UUID) 2>/dev/null || \
	journalctl -f -o cat | grep -i clipo

debug:
	@echo "Starting nested GNOME Shell for testing..."
	@echo "(This creates a window-in-window GNOME Shell instance)"
	@echo ""
	MUTTER_DEBUG_DUMMY_MODE_SPECS=1024x768 dbus-run-session -- gnome-shell --nested --wayland

help:
	@echo ""
	@echo "Clipo - GNOME Clipboard Manager"
	@echo "================================"
	@echo ""
	@echo "Available commands:"
	@echo ""
	@echo "  make install   - Install extension to ~/.local/share/gnome-shell/extensions/"
	@echo "  make uninstall - Remove the extension"
	@echo "  make enable    - Enable the extension via gnome-extensions"
	@echo "  make disable   - Disable the extension"
	@echo "  make restart   - Show instructions to restart GNOME Shell"
	@echo "  make logs      - View extension logs (for debugging)"
	@echo "  make debug     - Run nested GNOME Shell for testing"
	@echo "  make dev       - Watch for changes and auto-reinstall"
	@echo "  make pack      - Create .zip for extensions.gnome.org"
	@echo "  make clean     - Remove compiled schemas"
	@echo ""
	@echo "Quick start:"
	@echo "  make install && make enable"
	@echo ""
	@echo "Then restart GNOME Shell (see 'make restart' for instructions)"
	@echo ""

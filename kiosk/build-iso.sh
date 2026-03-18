#!/bin/bash
# ============================================================================
# Rosenweg Kiosk - ISO Builder
# ============================================================================
# Downloads Debian 13 (Trixie) netinst ISO and repacks it with:
#   - preseed.cfg for fully automated installation
#   - SSH deploy key for private config repo access
#
# Requirements:
#   sudo apt install xorriso isolinux cpio gzip curl
#
# Usage:
#   # 1. Generate deploy key (once):
#   ssh-keygen -t ed25519 -f deploy-key -N "" -C "rosenweg-kiosk"
#   # 2. Add deploy-key.pub to GitHub repo Settings > Deploy Keys (with write access)
#   # 3. Build ISO:
#   sudo ./build-iso.sh
#
# Output: rosenweg-kiosk.iso
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="/tmp/rosenweg-kiosk-iso"
DEBIAN_ISO_URL="https://cdimage.debian.org/cdimage/weekly-builds/amd64/iso-cd/debian-testing-amd64-netinst.iso"
DEBIAN_ISO="$WORK_DIR/debian-netinst.iso"
OUTPUT_ISO="$SCRIPT_DIR/rosenweg-kiosk.iso"
DEPLOY_KEY="$SCRIPT_DIR/deploy-key"

# --- Check root ---
if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: This script must be run as root (for mount)."
    exit 1
fi

# --- Check dependencies ---
for cmd in xorriso cpio curl; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "ERROR: '$cmd' is required. Install with:"
        echo "  sudo apt install xorriso cpio curl"
        exit 1
    fi
done

# --- Check required files ---
if [ ! -f "$SCRIPT_DIR/preseed.cfg" ]; then
    echo "ERROR: preseed.cfg not found in $SCRIPT_DIR"
    exit 1
fi

if [ ! -f "$DEPLOY_KEY" ]; then
    echo "ERROR: SSH deploy key not found at $DEPLOY_KEY"
    echo ""
    echo "Generate one with:"
    echo "  ssh-keygen -t ed25519 -f $DEPLOY_KEY -N '' -C 'rosenweg-kiosk'"
    echo ""
    echo "Then add $DEPLOY_KEY.pub as a Deploy Key in your private GitHub repo"
    echo "(Settings > Deploy Keys, enable 'Allow write access')."
    exit 1
fi

echo "=== Rosenweg Kiosk ISO Builder ==="
echo ""

# --- Setup work directory ---
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/iso" "$WORK_DIR/mnt"

# --- Download Debian ISO ---
if [ -f "$SCRIPT_DIR/.cached-debian-netinst.iso" ]; then
    echo "[1/5] Using cached Debian ISO."
    DEBIAN_ISO="$SCRIPT_DIR/.cached-debian-netinst.iso"
else
    echo "[1/5] Downloading Debian 13 netinst ISO..."
    curl -fL -o "$DEBIAN_ISO" "$DEBIAN_ISO_URL"
fi

# --- Extract ISO contents ---
echo "[2/5] Extracting ISO..."
mount -o loop "$DEBIAN_ISO" "$WORK_DIR/mnt"
cp -a "$WORK_DIR/mnt/." "$WORK_DIR/iso/"
umount "$WORK_DIR/mnt"
chmod -R u+w "$WORK_DIR/iso"

# --- Inject preseed.cfg and deploy key into initrd ---
echo "[3/5] Injecting preseed.cfg and deploy key into initrd..."
INITRD_DIR="$WORK_DIR/initrd"
mkdir -p "$INITRD_DIR"

cd "$INITRD_DIR"
gzip -d < "$WORK_DIR/iso/install.amd/initrd.gz" | cpio -id 2>/dev/null

# Copy preseed and deploy key into initrd root
cp "$SCRIPT_DIR/preseed.cfg" "$INITRD_DIR/preseed.cfg"
cp "$DEPLOY_KEY" "$INITRD_DIR/deploy-key"
chmod 600 "$INITRD_DIR/deploy-key"

# Repack initrd
find . | cpio -o -H newc 2>/dev/null | gzip > "$WORK_DIR/iso/install.amd/initrd.gz"
cd "$SCRIPT_DIR"

# --- Modify boot config for automated install ---
echo "[4/5] Configuring automated boot..."

# BIOS boot (isolinux)
if [ -f "$WORK_DIR/iso/isolinux/isolinux.cfg" ]; then
    cat > "$WORK_DIR/iso/isolinux/isolinux.cfg" << 'EOF'
DEFAULT auto
TIMEOUT 30
PROMPT 0

LABEL auto
    MENU LABEL ^Rosenweg Kiosk - Automatische Installation
    kernel /install.amd/vmlinuz
    append auto=true priority=critical file=/preseed.cfg initrd=/install.amd/initrd.gz locale=de_CH.UTF-8 keymap=ch --- quiet
EOF
fi

# UEFI boot (grub)
if [ -f "$WORK_DIR/iso/boot/grub/grub.cfg" ]; then
    cat > "$WORK_DIR/iso/boot/grub/grub.cfg" << 'EOF'
set default=0
set timeout=3

menuentry "Rosenweg Kiosk - Automatische Installation" {
    linux /install.amd/vmlinuz auto=true priority=critical file=/preseed.cfg locale=de_CH.UTF-8 keymap=ch --- quiet
    initrd /install.amd/initrd.gz
}
EOF
fi

# --- Regenerate md5sums ---
cd "$WORK_DIR/iso"
find . -type f ! -name "md5sum.txt" ! -path "./isolinux/*" -exec md5sum {} \; > md5sum.txt
cd "$SCRIPT_DIR"

# --- Build new ISO ---
echo "[5/5] Building rosenweg-kiosk.iso..."

EFI_ARGS=""
if [ -f "$WORK_DIR/iso/boot/grub/efi.img" ]; then
    EFI_ARGS="-eltorito-alt-boot -e boot/grub/efi.img -no-emul-boot"
fi

xorriso -as mkisofs \
    -o "$OUTPUT_ISO" \
    -isohybrid-mbr /usr/lib/ISOLINUX/isohdpfx.bin \
    -c isolinux/boot.cat \
    -b isolinux/isolinux.bin \
    -no-emul-boot \
    -boot-load-size 4 \
    -boot-info-table \
    $EFI_ARGS \
    -R -J -v -T \
    "$WORK_DIR/iso"

# --- Cleanup ---
rm -rf "$WORK_DIR"

echo ""
echo "=== ISO built successfully! ==="
echo ""
echo "Output: $OUTPUT_ISO"
echo "Size:   $(du -h "$OUTPUT_ISO" | cut -f1)"
echo ""
echo "Write to USB stick:"
echo "  sudo dd if=$OUTPUT_ISO of=/dev/sdX bs=4M status=progress"
echo ""
echo "The ISO contains:"
echo "  - Automated Debian 13 installer"
echo "  - SSH deploy key for private config repo"
echo "  - Auto-downloads setup-kiosk.sh from GitHub during install"
echo ""

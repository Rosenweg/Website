#!/bin/bash
# Rosenweg Kiosk - Chromium Launcher
# Clears previous session data and starts Chromium in kiosk mode

# Clear previous session data
rm -rf /home/kiosk/.config/chromium/Default/Local\ Storage/* 2>/dev/null
rm -rf /home/kiosk/.config/chromium/Default/Session\ Storage/* 2>/dev/null
rm -rf /home/kiosk/.config/chromium/Default/Cookies* 2>/dev/null
rm -rf /home/kiosk/.config/chromium/Default/Cache/* 2>/dev/null

exec chromium \
    --kiosk \
    --no-first-run \
    --disable-translate \
    --disable-infobars \
    --disable-suggestions-service \
    --disable-save-password-bubble \
    --disable-session-crashed-bubble \
    --disable-features=TranslateUI \
    --disable-component-update \
    --noerrdialogs \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --remote-debugging-port=9222 \
    --autoplay-policy=no-user-gesture-required \
    --check-for-update-interval=31536000 \
    --disable-background-networking \
    "https://www.rosenweg4303.ch"

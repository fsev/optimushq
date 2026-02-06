#!/bin/bash
# Start headless Chrome with remote debugging for Claude Chat

# Clean up old profile to prevent disk space accumulation
rm -rf /tmp/chrome-chat-profile

DISPLAY=:99 google-chrome \
  --no-first-run \
  --no-default-browser-check \
  --disable-gpu \
  --disable-software-rasterizer \
  --remote-debugging-port=9222 \
  --window-size=1280,720 \
  --user-data-dir=/tmp/chrome-chat-profile \
  --disk-cache-size=52428800 \
  --media-cache-size=52428800 \
  --no-sandbox \
  about:blank > /tmp/chrome-chat.log 2>&1 &

echo "Chrome started with PID $!"

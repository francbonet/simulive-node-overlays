#!/usr/bin/env bash
set -e
mkdir -p hls
for f in vod/*.mp4; do
  [ -e "$f" ] || continue
  base=$(basename "$f" .mp4)
  out="hls/$base"
  mkdir -p "$out"
  ffmpeg -hide_banner -loglevel warning -y -fflags +genpts -i "$f" \
    -vf "scale=w=1280:h=720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,settb=AVTB,setpts=N/(30*TB)" \
    -r 30 \
    -c:v libx264 -profile:v main -preset veryfast -b:v 2500k -maxrate 2500k -bufsize 5000k \
    -g 120 -keyint_min 120 -sc_threshold 0 \
    -c:a aac -b:a 128k -ac 2 -ar 48000 \
    -muxpreload 0 -muxdelay 0 -avoid_negative_ts make_zero \
    -hls_time 4 -hls_flags independent_segments \
    -hls_segment_filename "$out/seg_%05d.ts" \
    -hls_playlist_type vod -hls_list_size 0 -f hls "$out/index.m3u8"
done

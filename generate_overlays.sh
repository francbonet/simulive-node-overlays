#!/usr/bin/env bash
set -e

FPS=30
SEG_DUR=8
GOP=$(( FPS * SEG_DUR ))
VBR="2500k"
MAXR="2500k"
BUF="5000k"
PAD_FILTER="scale=w=1280:h=720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2"

FONT_FILE="/Library/Fonts/Arial.ttf"
[ -f "$FONT_FILE" ] || FONT_FILE="/System/Library/Fonts/Supplemental/Arial.ttf"

OVERLAYS_JSON="overlays.json"
VOD_DIR="vod"
OUT_DIR="hls_ovr"

mkdir -p "$OUT_DIR"

if ! command -v jq >/dev/null 2>&1; then
  echo "Necessites 'jq': brew install jq"
  exit 1
fi
if ! command -v ffprobe >/dev/null 2>&1; then
  echo "Necessites 'ffprobe' (ve amb ffmpeg)"
  exit 1
fi

overlays_for_program() {
  local program="$1"
  jq -c --arg P "$program" '.[] | select(.program==$P)' "$OVERLAYS_JSON"
}

x_expr() {
  local val="$1"
  if [ -z "$val" ] || [ "$val" = "center" ]; then echo "(main_w-overlay_w)/2"
  elif [ "$val" = "left" ]; then echo "0"
  elif [ "$val" = "right" ]; then echo "main_w-overlay_w"
  elif [[ "$val" == *% ]]; then local p="${val%%%}"; echo "($p/100)*(main_w-overlay_w)"
  elif [[ "$val" =~ ^[0-9]+$ ]]; then echo "$val"
  else echo "$val"; fi
}
y_expr() {
  local val="$1"
  if [ -z "$val" ] || [ "$val" = "bottom" ]; then echo "main_h-overlay_h"
  elif [ "$val" = "top" ]; then echo "0"
  elif [ "$val" = "middle" ] || [ "$val" = "center" ]; then echo "(main_h-overlay_h)/2"
  elif [[ "$val" == *% ]]; then local p="${val%%%}"; echo "($p/100)*(main_h-overlay_h)"
  elif [[ "$val" =~ ^[0-9]+$ ]]; then echo "$val"
  else echo "$val"; fi
}

for f in "$VOD_DIR"/*.mp4; do
  [ -e "$f" ] || continue
  base=$(basename "$f" .mp4)
  out="$OUT_DIR/$base"
  mkdir -p "$out"

  # --- detecta si té audio ---
  HAS_AUDIO=0
  if ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "$f" | grep -q '^audio$'; then
    HAS_AUDIO=1
  fi

  FILTER_COMPLEX="[0:v]$PAD_FILTER,setsar=1[v0]"
  VIDX="v0"
  DRAWTEXT=""
  IMAGE_INPUTS_ARGS=()

  # Itera overlays per aquest programa (1a passada: recollim text/imatges)
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    START=$(echo "$row" | jq -r '.start')
    END=$(echo   "$row" | jq -r '.end')
    TEXT=$(echo  "$row" | jq -r '.text // empty')
    IMG=$(echo   "$row" | jq -r '.image // empty')
    POSX=$(echo  "$row" | jq -r '.posX // empty')
    POSY=$(echo  "$row" | jq -r '.posY // empty')
    SCALE=$(echo "$row" | jq -r '.scale // 1.0')

    # Escapat robust text
    TEXT_ESC="$TEXT"
    TEXT_ESC="${TEXT_ESC//\\/\\\\}"
    TEXT_ESC="${TEXT_ESC//\'/\\\'}"
    TEXT_ESC="${TEXT_ESC//:/\\:}"

    if [ -n "$TEXT_ESC" ]; then
      DRAWTEXT="$DRAWTEXT,drawtext=fontfile='$FONT_FILE':text='${TEXT_ESC}':fontcolor=white:fontsize=28:x=0.05*w:y=h-60:box=1:boxcolor=0x000000AA:boxborderw=8:enable='between(t,$START,$END)'"
    fi

    if [ -n "$IMG" ] && [ -f "$IMG" ]; then
      IMAGE_INPUTS_ARGS+=( -i "$IMG" )
    fi
  done < <(overlays_for_program "$base")

  # 2a passada: construïm la cadena d'overlays d’imatges
  FILTER="$FILTER_COMPLEX"
  VIDX="v0"
  # si NO hi ha àudio original, afegirem anullsrc com a segona entrada; per tant, imatges començaran a 2
  # si sí que hi ha àudio original, les imatges començaran a 1
  IMG_BASE_INPUT=$(( HAS_AUDIO == 1 ? 1 : 2 ))

  if [ "${#IMAGE_INPUTS_ARGS[@]}" -gt 0 ]; then
    J=0
    while IFS= read -r row; do
      [ -n "$row" ] || continue
      IMG=$(echo "$row" | jq -r '.image // empty')
      [ -n "$IMG" ] && [ -f "$IMG" ] || { continue; }
      START=$(echo "$row" | jq -r '.start')
      END=$(echo   "$row" | jq -r '.end')
      POSX=$(echo  "$row" | jq -r '.posX // empty')
      POSY=$(echo  "$row" | jq -r '.posY // empty')
      SCALE=$(echo "$row" | jq -r '.scale // 1.0')

      X=$(x_expr "$POSX"); Y=$(y_expr "$POSY")
      INIDX=$((IMG_BASE_INPUT + J))
      FILTER="$FILTER;[$INIDX:v]scale=w=trunc(1280*${SCALE}):h=-1:flags=lanczos[i$J];[$VIDX][i$J]overlay=x=$X:y=$Y:enable='between(t,$START,$END)'[v$J]"
      VIDX="v$J"
      J=$((J+1))
    done < <(overlays_for_program "$base")
  fi

  # --- Normalització temporal final (CFR i timebase estable) ---
  # afegim fps=${FPS}, settb=AVTB, setpts=N/(${FPS}*TB) per garantir PTS/DTS estrictament creixents
  if [ -n "$DRAWTEXT" ]; then
    FILTER="$FILTER;[$VIDX]${DRAWTEXT#,},fps=${FPS},settb=AVTB,setpts=N/(${FPS}*TB)[vout]"
    VOUT="vout"
  else
    FILTER="$FILTER;[$VIDX]fps=${FPS},settb=AVTB,setpts=N/(${FPS}*TB)[vout]"
    VOUT="vout"
  fi

  echo ">>> Generant HLS amb overlays per $base ... (audio present: $HAS_AUDIO)"
  # Inputs: 0) video; (opcional) 1) anullsrc; després imatges
  CMD=( ffmpeg -hide_banner -loglevel warning -y -fflags +genpts -i "$f" )
  if [ "$HAS_AUDIO" -eq 0 ]; then
    CMD+=( -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 )
  fi
  if [ "${#IMAGE_INPUTS_ARGS[@]}" -gt 0 ]; then
    CMD+=( "${IMAGE_INPUTS_ARGS[@]}" )
  fi

  CMD+=( -filter_complex "$FILTER"
        -map "[$VOUT]" )

  if [ "$HAS_AUDIO" -eq 1 ]; then
    CMD+=( -map 0:a:0 )
  else
    CMD+=( -map 1:a:0 )
  fi

  CMD+=( -r $FPS
        -c:v libx264 -profile:v main -preset veryfast -b:v $VBR -maxrate $MAXR -bufsize $BUF
        -g $GOP -keyint_min $GOP -sc_threshold 0
        -c:a aac -b:a 128k -ac 2 -ar 48000
        -shortest
        # Mux “estricte” i timestamps no-negatius
        -muxpreload 0 -muxdelay 0 -avoid_negative_ts make_zero
        # TS/HLS
        -hls_time $SEG_DUR -hls_flags independent_segments
        -hls_segment_filename "$out/seg_%05d.ts"
        -hls_playlist_type vod -hls_list_size 0 -f hls "$out/index.m3u8" )

  "${CMD[@]}"
done

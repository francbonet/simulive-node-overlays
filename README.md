# Simulive HLS Overlays

Servidor Node que expone `/channel/ovr.m3u8` como un directo continuo uniendo varios VODs HLS,
con opción de overlays pre-generados con FFmpeg.

## Requisitos
- Node 18+
- FFmpeg instalado
- VODs HLS accesibles en `public/hls/AB-xxx/index.m3u8`

## Instalación
```bash
npm i
```

## (Opcional) Generar overlays
Coloca los MP4 en `public/vod/AB-001.mp4` (uno por programa) o deja que lea del HLS.
Asegúrate de que las imágenes existan en `public/assets` (por ejemplo, `faldon.png`, `logo.png`).

```bash
npm run gen:overlays
```

Esto creará `public/hls_ovr/AB-xxx/index.m3u8` para los programas definidos en `config/overlays.json`.
Si no existe versión overlay, el servidor usará el playlist base de `public/hls/...`.

## Ejecutar
```bash
npm start
```

- Playlist live: http://localhost:8080/channel/ovr.m3u8
- Player:        http://localhost:8080/player.html

## Notas
- Usa `#EXT-X-DISCONTINUITY` al cambiar de programa.
- Inserta `#EXT-X-PROGRAM-DATE-TIME` para sincronizar el live.
- Recomiendo regenerar VODs con GOP estable para evitar errores de DTS.
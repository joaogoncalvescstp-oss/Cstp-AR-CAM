# Cstp-AR-CAM

Field CAD line AR viewer: a mobile web app that loads **LandXML alignments** and shows them in
**augmented reality** over the phone camera, using the phone's GPS, compass, gyroscope and
accelerometer. Take **geotagged photos** with the alignment overlay, station and offset stamped on them.

Set up for **Saint Paul, Minnesota**: coordinates default to the **Ramsey County Coordinate System**
(NAD83, US survey feet), exactly the same transform as
[FBK-Checker](https://joaogoncalvescstp-oss.github.io/FBK-Checker/), and distances and stationing are shown
in US feet (`12+34.56`).

The look (Big Rivers Blue / Sky Blue / gold, glass header with the Saint Paul logo, white nav buttons around a
raised logo camera button, Polaroid photo strip and carousel viewer) follows
[CstpTieCam](https://github.com/joaogoncalvescstp-oss/CstpTieCam).

No build step, no server code, no external CDN: it is a static site (works offline after the first visit).

## Coordinate system (Ramsey County)

| Parameter | Value |
|---|---|
| Projection | Lambert Conformal Conic (2SP) |
| Ellipsoid | county-enlarged GRS80: a = 6 378 418.941 m, b = 6 357 033.31 m |
| Standard parallels | 44°53′ N, 45°08′ N |
| Central meridian | 93°23′ W |
| Latitude of origin | 44°47′28″ N |
| False easting / northing | 500 000 / 100 000 US survey ft |
| Units | US survey foot (1200/3937 m) |
| Datum shift | none (lat/lon are NAD83, used directly as GPS WGS84 ≈ 1 m) |

proj4: `+proj=lcc +lat_1=44.88333333333333 +lat_2=45.13333333333333 +lat_0=44.79111111111111 +lon_0=-93.38333333333333 +x_0=152400.3048006096 +y_0=30480.06096012192 +a=6378418.941 +b=6357033.31 +units=us-ft +no_defs`

Checked against FBK-Checker's `surveyToLL` / `llToSurvey`: identical to about 1e-8 ft. Files without a
`<CoordinateSystem>` use Ramsey County automatically; files whose coordinate system name mentions "Ramsey" are
mapped to this definition; other EPSG/WKT codes in a file are honoured.

## Features

- **LandXML 1.x import** (multiple files, drag & drop on desktop)
  - Horizontal geometry: `Line`, `Curve` (arcs), `Spiral` (clothoids), `IrregularLine`, `Chain`
  - Vertical profiles: `PVI`, `ParaCurve`, `CircCurve`, `UnsymParaCurve`
  - `CgPoints` (shown as labelled markers), `CoordinateSystem` (EPSG / WKT), metric and imperial units
- **AR view** (three.js)
  - Centreline, optional offset lines (e.g. lane edges `-12, 12` ft), station ticks and labels with design Z
  - US feet with `12+34.56` stationing (default) or metres with `1+234.56` (Settings ▸ Units)
  - Height models: design profile relative to the nearest station, absolute (GPS/manual elevation), or flat
  - Live HUD: alignment, **station**, **offset (L/R)**, design Z, GPS accuracy, heading/pitch, compass tape
  - Pulsing marker at the nearest point on the alignment + edge arrow when it is off-screen
- **Georeferencing**
  - Ramsey County (default), NAD83 / UTM 15N and other presets, the CRS declared in the file, any UTM code
    offline, or any EPSG code / proj4 string / WKT (looked up online once and cached)
  - **Local anchor** mode for files without a CRS: pin a station at your position, facing along the alignment
- **Sensors**
  - Orientation: `AbsoluteOrientationSensor` (Android Chrome) → `deviceorientationabsolute` → iOS `webkitCompassHeading`
  - GPS with accuracy-weighted smoothing and a "freeze position" lock
  - Gyro/accelerometer for a steady-shot indicator (shutter ring turns green)
  - Torch and zoom (when the camera supports them), screen wake lock, vibration feedback
  - Live calibration panel: heading, height and camera FOV nudges, and **"Align heading to alignment"**
- **Photos**
  - Camera frame + AR overlay + info box (time, lat/lon, accuracy, heading, pitch, alignment, station, offset, Ramsey N/E)
  - EXIF GPS position, altitude, image direction and timestamp written into the JPEG
  - Stored on the device (IndexedDB); gallery with notes, share, download, CSV photo log export
- **Plan view** map with alignments, stations, points, your position and view cone

## Using it

1. Open the site on your phone over **HTTPS** (camera, GPS and compass require a secure origin).
2. Tap **Start AR camera** and allow camera, location and motion access.
3. **Files ▸ Load LandXML…** and pick your `.xml`.
4. The coordinate system is Ramsey County by default (change it under Files if a file uses another one), or
   choose *Local – pin to my position* and tap **Pin station here** while pointing along the alignment.
5. Walk. The HUD shows station / offset; tap the shutter to take a photo.

**Accuracy tips:** phone GPS is typically ±2–5 m and compasses drift a few degrees. Use 🧭 to fine-tune:
stand on a known point of the alignment, point along it and tap *Align heading to alignment*. Use 📍 to freeze
the position while photographing. Elevations from GPS are ellipsoidal — in Saint Paul NAVD88 elevations are roughly 90 ft
(≈ 27.5 m) higher than GPS ellipsoid heights, so use the *vertical offset / geoid correction* setting in
*absolute* mode, or keep the default *relative* height model.

Try it without a file: **Try demo** places a 1050 ft road (tangent, clothoid, R650 ft curve, clothoid, tangent, with a
crest vertical curve) 16 ft in front of you. **Saint Paul sample** (`samples/saint-paul-ramsey.xml`) is the same road
in Ramsey County coordinates, starting near the Minnesota State Capitol.

On a desktop browser without sensors you can drag to look around and use **Map ▸ Simulate here** to place yourself.

## Hosting

Any static host with HTTPS works. The included workflow `.github/workflows/pages.yml` deploys to GitHub Pages on
every push to `main` (enable *Settings ▸ Pages ▸ Source: GitHub Actions* once).

Local testing: `npx http-server -p 8080` and open `http://localhost:8080` (localhost counts as secure). To test on a
phone over the LAN you need HTTPS, e.g. a tunnel such as `npx localtunnel --port 8080`.

## Project layout

```
index.html            UI shell
css/style.css
js/app.js             controller: UI, main loop, photo capture
js/landxml.js         LandXML parser, station/offset, profile elevation
js/geo.js             CRS handling (proj4, Ramsey County definition), local anchor, lat/lon <-> local ENU
js/units.js           US feet / metric display and stationing
js/sensors.js         orientation fusion, GPS, motion, wake lock
js/camera.js          rear camera stream, FOV model, torch/zoom
js/ar.js              three.js AR scene
js/plan.js            2D plan view
js/photos.js          photo composition, EXIF, IndexedDB storage, CSV export
sw.js                 offline cache
vendor/               three.js r186, proj4js 2.22, piexifjs 1.0.6
samples/              demo LandXML files (tools/make_demo.py generates them)
```

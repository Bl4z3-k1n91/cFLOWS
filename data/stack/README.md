# cFLOWS public-data stack

Only import data that is public and permitted for your use. cFLOWS keeps each
source separate in the evidence ledger; it does not turn an imported layer into
a live sensor.

## Optional local inputs

| File | Purpose | Source boundary |
|---|---|---|
| `data/assets/overture-buildings.geojson` | Building-footprint runoff estimate | Download an area subset from Overture Maps Explorer or CLI; no account required. |
| `data/assets/cartodem-30m.tif` | Offline terrain baseline | Public CartoDEM 1-arc-second/30 m product; a 10 m DEM is not treated as open data. |
| `data/assets/cop-dem-glo-30.tif` | Alternative 30 m terrain baseline | Copernicus GLO-30; access rules may require a Copernicus profile. |
| `data/imerg/imerg-halfhourly.csv` | Historic 30-minute rainfall replay | NASA IMERG 0.1-degree data; do not call this street-scale rain. |
| `data/calibration/sentinel-flood-labels.geojson` | Flood-extent labels | Sentinel-1 before/after flood extent with event time and provenance. |

The app runs without these files. It displays an import-needed status rather
than claiming the higher-resolution layer is active.

## Overture example

```powershell
pip install overturemaps
overturemaps download --type building --bbox 80.10,12.85,80.35,13.25 -f geojson -o data/assets/overture-buildings.geojson
```

Keep the imported area bounded. Do not commit large local rasters or downloads
to Git; cFLOWS will detect them at runtime.

For Sentinel labels, use a GeoJSON FeatureCollection. Each flood polygon needs
`properties.timestamp` (or `event_time`), `district: "Chennai"`, and a
`flooded` flag. Imported labels enter the calibration gate but do not make a
depth claim by themselves.

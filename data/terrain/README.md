# Optional local terrain samples

For higher-quality local surface screening, place reviewed elevation samples in
`local-elevation-samples.json`. cFLOWS will prefer this file over the public
Open-Elevation fallback whenever at least nine samples cover the selected area.

```json
{
  "source": "surveyed / DEM-derived local terrain export",
  "resolutionM": 5,
  "samples": [
    { "latitude": 12.9768, "longitude": 80.2205, "elevationM": 6.42 }
  ]
}
```

The file should contain enough points around each area of interest to resolve
local relief. Supplying a high-resolution source improves the screening raster;
it does not turn unmodelled kerbs, walls, culverts or buildings into known
hydraulic boundaries.

# Downstream boundary inputs

cFLOWS will only pass a river/outfall stage into EPA SWMM when the input file
explicitly certifies that its vertical datum is compatible with the GCC drain
invert elevations.

For a fixed stage, create `live.json` (or an event id such as `chennai-2015.json`):

```json
{
  "source": "surveyed or reviewed gauge source",
  "datum": "documented vertical datum",
  "datumCompatibleWithGccInverts": true,
  "stageM": 2.15
}
```

For a historical stage series use:

```json
{
  "source": "reviewed historical river-stage reconstruction",
  "datum": "documented vertical datum",
  "datumCompatibleWithGccInverts": true,
  "series": [
    { "time": "2015-12-01T00:00:00+05:30", "stageM": 1.9 },
    { "time": "2015-12-01T01:00:00+05:30", "stageM": 2.0 }
  ]
}
```

Do not put offshore model sea level here unless its datum has been reconciled
to the drain/river model. Missing or incompatible data is intentionally blocked.

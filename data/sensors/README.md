# Trusted sensor adapter

cFLOWS never fabricates water-level or velocity telemetry. A deployment can
provide a trusted snapshot at `data/sensors/live.json` or set
`CFLOWS_SENSOR_FEED` to another JSON file.

Example schema:

```json
{
  "source": "municipal telemetry gateway",
  "observedAt": "2026-09-07T10:30:00+05:30",
  "segments": [
    {
      "segmentId": "gcc-12345",
      "upstreamLevelRatio": 0.82,
      "downstreamLevelRatio": 0.31,
      "velocityMs": 0.22,
      "suspendedSolidsNtu": 120
    }
  ]
}
```

Snapshots older than ten minutes are labelled stale and receive no live-sensor
confidence credit. The citizen-facing renderer has no API that can mark a
report as verified or write this sensor file.

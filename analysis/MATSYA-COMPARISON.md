# Matsya vs cFLOWS — feature comparison and integration record

Comparison target: `shalonjovan/Matsya`, inspected at commit `ea58d89` on 7 September 2026.

This document records product capabilities, not a claim that the two hydraulic models are equivalent. cFLOWS keeps its evidence-first rule: a useful feature is ported only when it can be implemented without turning an assumed quantity into an observed fact.

## What Matsya had that cFLOWS did not

| Matsya capability | cFLOWS status after integration | Notes |
|---|---|---|
| Time-shaped rainfall curves and multi-hour duration | Integrated | Deterministic Steady, Cloudburst, Builds up and Two-wave profiles now drive both EPA SWMM and the surface raster. |
| Place/coordinate search | Integrated | Chennai place lookup plus direct `lat,lon` entry in What-if. |
| Layer controls for flood/drainage/water/infrastructure | Integrated | Flood, GCC drains, OSM roads, water features and important facilities can be toggled. |
| Point inspector | Integrated | Click a modelled flood cell after a run to inspect its rounded screening band/depth. |
| Affected roads / infrastructure | Integrated conservatively | Nearby OSM roads and facilities are ranked against the screening raster; output explicitly says it is not an observed closure/flood report. |
| Simulation/world library | Integrated | Saved tests can be renamed, duplicated, deleted and imported. |
| Portable scenario package | Integrated | cFLOWS JSON bundle can be exported/imported; CSV summary and flood GeoJSON exports were added too. |
| Timeline playback for scenario duration | Extended | cFLOWS playback now follows the selected 1–12 hour storm rather than a fixed 2-hour UI assumption. |
| Waterbody display/inspection | Partially integrated, evidence-gated | OSM water features are shown as context. cFLOWS does not calculate lake overtopping without reviewed stage/storage/crest data. |
| River overload / river spill | Not fabricated | Matsya's implementation can fall back to assumed channel dimensions. cFLOWS retains its datum-checked downstream boundary interface and will add river spill only when channel/stage/flow evidence is supplied. |
| Initial lake-fill percentage | Not exposed without real lake storage data | A percentage slider would imply a known storage geometry that cFLOWS currently does not possess. |
| ANUGA / TELEMAC / LISFLOOD / Itzi experimentation | Not adopted as a production feature | Matsya includes mock/experimental engine work. cFLOWS keeps its current SWMM + explicitly labelled diffusive-wave screening path until a high-resolution 2D model can be validated. |
| React/FastAPI/Docker architecture | Not ported | This is an implementation stack, not a missing user capability. cFLOWS remains an Electron/local-first application. |

## What cFLOWS already did more strictly

- Normalizes conflicting GCC `drain_size` / raw dimension fields and withholds ambiguous legacy dimensions.
- Models GCC `Closed` drains as `RECT_CLOSED` in EPA SWMM.
- Separates coincident public-GIS topology from surveyed/confirmed connectivity.
- Prevents drains outside the 480 m terrain domain from receiving local surface-drainage credit.
- Requires datum compatibility before a river/outfall stage is passed into SWMM.
- Separates unverified citizen reports from trusted sensor/crew evidence and prevents unverified reports from authorizing an operational action.
- Requires independent train/holdout flood observations before exact depth can be described as calibrated.
- Has a reproducible 2015 Chennai hindcast/failure-mode regression and a production SWMM flooded-node parser regression.
- Uses a public-facing `We know / We estimate / We don't know yet` confidence explanation rather than presenting model precision as observation precision.

## New implementation details

### Storm profiles

`src/core/rainfall-profile.js` produces a deterministic timestamped series. The selected peak intensity is guaranteed to appear in the actual series. The same series is consumed by:

- `src/core/swmm.js` — dynamic SWMM rain-gauge interval, timeseries rows and run end time.
- `src/core/raster-spill.js` — minute-by-minute variable rainfall forcing.

This closes an important weakness found in the 2015 audit: equal rainfall totals can produce very different flooding depending on temporal concentration.

### Impact screening

`src/core/impact.js` intersects the final surface screening raster with nearby OSM roads and important facilities. It ranks possible impact but deliberately does not create road-closure, hospital-flooding, or safety-clearance claims.

### Water and river handling

Matsya's waterbody and river ideas are useful, but cFLOWS does not have enough reviewed lake storage, crest, river cross-section, historical stage, or flow data to reproduce them honestly. For now:

- mapped water is a visible context layer;
- reviewed downstream stages can constrain SWMM through the existing datum-gated adapter;
- missing river/lake state stays visible as missing evidence.

The next physically meaningful step is not another default parameter. It is importing reviewed river/waterbody geometry plus stage/storage/flow observations, then coupling those boundaries to the local drain and surface models.

## Verification after integration

- `npm test`: 41/41 passing.
- Real EPA SWMM integration tests pass for representative, connected, closed-boundary and multi-hour time-shaped storms.
- `npm run preflight`: passes.
- `npm run smoke`: `CFLOWS_SMOKE_OK preload bridge ready`.
- `npm run hindcast:2015`: passes after pinning the audited eight-link Velachery regression network so live GCC cache growth cannot silently change the reference network.
- 2015 production-fixed Chembarambakkam stress regression: 1 flooded node, approximately 628 m³ overflow, 5.39 h flooding, 1.629 m maximum SWMM ponded depth, 2.27 maximum full-flow ratio, 0 SWMM warnings.
- `git diff --check`: clean apart from normal Windows line-ending notices.


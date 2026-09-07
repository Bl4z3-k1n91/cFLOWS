# cFLOWS — Chennai Flows

An evidence-first Chennai flood-nowcasting prototype built for SIH PS 26085. It combines public Greater Chennai Corporation drain geometry, rainfall forecasts, elevation, flood-news signals, citizen reports, and an on-demand EPA SWMM hydraulic run.

It is deliberately honest about its limits: public geometry is not a surveyed, connected citywide drainage network, and the local inundation screening is an exploratory scenario aid, not a validated emergency instruction.

## What it demonstrates

- A Chennai map with public drain geometry and click-to-inspect flow context.
- Plain-language flood questions via a local FreeLLMAPI-compatible endpoint.
- A scenario workspace: choose a place, set rainfall intensity, inspect the nearest mapped drain, and see an uncertainty-labelled local inundation screening band.
- A drain-graph builder that distinguishes coincident public-GIS endpoints, proximity-only candidates, and surveyed/confirmed topology. Only coincident endpoints may drive exploratory propagation automatically.
- A historical calibration gate that requires explicitly separated training and held-out depth observations plus sub-daily rainfall before depth output can be called calibrated.
- A two-tier scenario model: EPA SWMM on geometry-snapped local reaches, followed by a mass-conserving Manning diffusive-wave screening raster. The raster is not presented as a kerb-scale 2D shallow-water solver.
- A persisted scenario ledger with evidence export, variable-duration topographic screening playback, and click-to-inspect raster cells.
- What-if storms can now vary from 1–12 hours and use deterministic Steady, Cloudburst, Builds-up or Two-wave rainfall shapes; the same timestamped forcing drives EPA SWMM and the surface raster.
- Scenario place search, flood/drain/road/water/facility map layers, click-to-inspect cells, and conservative road/facility impact ranking.
- A scenario library with rename, duplicate, delete and JSON import/export, plus CSV summary, flood GeoJSON and printable report exports.
- Evidence ledger and data-source status rather than made-up sensor coverage.
- EPA SWMM runs that stop when essential drain dimensions or invert levels are missing.
- GCC drain dimensions are normalized against `drain_size`; material raw-field conflicts are corrected centrally, ambiguous legacy dimensions are withheld, and `drain_detl=Closed` is modelled as a closed rectangular conduit.
- A reviewed downstream-stage adapter (`data/boundary/live.json`) can drive SWMM fixed/time-series outfall stages only after explicit vertical-datum compatibility is declared. Offshore sea-level context is never silently reused as a drain/river stage.
- A trusted sensor-file adapter (`data/sensors/live.json` or `CFLOWS_SENSOR_FEED`) with freshness validation; citizen reports remain unverified and cannot authorize automatic dispatch.
- Cached fallbacks for public contextual feeds. Cached rainfall is always marked stale and never promoted to a live nowcast input.
- Working Network and Analytics views that expose topology evidence, validation gates, missing inputs and held-out metrics instead of static demo numbers.

## Run locally

Prerequisites: Node.js 20+ and npm. For hydraulic simulations, install EPA SWMM or build the bundled source with a supported C compiler.

```powershell
npm install
npm run setup
npm start
```

To enable the assistant, create `.env` from `.env.example` and either paste a FreeLLMAPI key as its only contents or configure `FREELLMAPI_API_KEY`. The default local API base URL is `http://127.0.0.1:31415/v1`.

For a multi-client deployment, run the optional shared report service and point
the Electron clients at it with `CFLOWS_SYNC_URL`. Loopback mode needs no token;
the server refuses non-loopback binding unless `CFLOWS_SYNC_TOKEN` is set.

```powershell
npm run sync-server
$env:CFLOWS_SYNC_URL = 'http://127.0.0.1:8787'
npm start
```

The same variables may be placed in `.env`. Trusted sensor telemetry can be
provided through `CFLOWS_SENSOR_FEED`; see `data/sensors/README.md`.

```powershell
npm test
npm run build:swmm
npm run preflight
npm run smoke
npm run hindcast:2015
```

## Data and modelling boundary

The app fetches public sources on demand. A location is matched to the nearest drain geometry in the GCC GIS layer. Endpoints that physically coincide within the geometry tolerance are snapped into shared exploratory SWMM nodes; proximity-only candidates remain disconnected. Neither is relabelled as surveyed topology. A drain outside the 480 m surface domain cannot contribute drainage credit to that surface scenario. The local multi-drain SWMM scenario is experimental and never used by itself for dispatch.

The network catchment prior is assigned per included reach and summed for the local network instead of dividing one selected reach's prior across the entire network. This remains a disclosed prior, not a substitute for surveyed catchment delineation. Reviewed river/outfall stages can be supplied through `data/boundary/`; missing or datum-incompatible stages remain explicitly missing.

Historical IMD rainfall and field reports are retained as evidence inputs. Rainfall alone cannot validate flood depth. Actual depth calibration requires time-matched observations with an explicit train/holdout split; classification metrics likewise remain withheld until the held-out gate is met. The import contract is documented in `data/calibration/README.md`.

Mapped roads, facilities and water features in the scenario view are contextual public-OSM evidence. A road crossing a modelled flooded cell is an impact-screening flag, not an official closure. Waterbody or river overtopping is not invented from generic default depths/capacities; it remains unavailable until reviewed stage/storage/cross-section data is supplied. See `analysis/MATSYA-COMPARISON.md` for the Matsya feature comparison and integration record.

Citizen reports are stored as `unverified` with conservative confidence, spatially scoped to the current decision area, duplicate-suppressed, and written atomically. They can trigger verification but cannot independently authorize dispatch. Trusted crew/sensor evidence must arrive through a separate integration path.

## Repository layout

- `src/` — UI, live-source adapters, decision logic, narration, and hydraulic helpers.
- `tests/` — automated checks for core decision behaviour and Electron entry point.
- `data/imd/` — IMD districtwise daily rainfall data used as a local evidence dataset.
- `data/sensors/` — contract for a trusted external telemetry snapshot; no fake sensor data is bundled.
- `data/boundary/` — contract for reviewed, datum-compatible downstream hydraulic stage inputs.
- `analysis/2015-hindcast/` — reproducible 2015 stress/hindcast outputs and failure-mode audit.
- `vendor/epa-swmm/` — EPA SWMM upstream source, included as a Git submodule.

## Safety

cFLOWS is a decision-support prototype. “No active flooding evidence” is deliberately not translated into “safe to travel.” Always defer to official disaster-management directions and do not use it as the sole basis for travel or emergency decisions.

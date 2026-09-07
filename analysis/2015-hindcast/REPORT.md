# cFLOWS 2015 Chennai flood hindcast audit

Generated from the September 2026 cFLOWS workspace. This is a failure-mode audit, not a validation claim: the workspace does not yet contain the raw 2015 hourly gauge files or georeferenced NRSC inundation polygons required for formal hindcast scores.

## Reproduction

```text
node scripts/hindcast-2015.js
```

Machine-readable outputs:

- `analysis/2015-hindcast/results.json`
- `analysis/2015-hindcast/swmm-summary.csv`
- `analysis/2015-hindcast/swmm/*.inp|*.rpt|*.out`

## Historical forcing used

- Nungambakkam: 294 mm reporting-day total, with an approximate hourly shape digitised from the published Rapid Assessment figure and normalized to the total.
- Taramani pilot proxy: 300 mm using the Nungambakkam temporal shape. This is a sensitivity proxy, not a validated Taramani hyetograph.
- Chembarambakkam upper-catchment stress: 475 mm, with an approximate hourly shape digitised from the published Rapid Assessment figure and normalized to the total. It is deliberately not described as local Taramani rainfall.
- Nungambakkam uniform sensitivity: the same 294 mm spread uniformly over 24 h.

These forcing reconstructions are useful for stress and sensitivity testing. They are not suitable for publishing calibration metrics.

## Remediation status after the audit

The production code has now been patched for the software defects exposed by this audit:

- `drain_size` / `drain_detl` are fetched and normalized centrally; material raw-field conflicts no longer inflate hydraulic dimensions.
- Closed GCC drains are emitted as `RECT_CLOSED` in EPA SWMM.
- The production SWMM 5.2 flooding-table parser now returns flooded-node count, total/max overflow volume, and maximum ponded depth correctly.
- Local-network catchment priors are assigned per reach and summed instead of dividing one selected reach's area across the whole network.
- Drains outside the 480 m surface domain receive zero surface-drainage credit and the network scenario is withheld for that locality.
- A reviewed downstream-stage adapter now supports fixed/time-series SWMM outfall stages only when the input explicitly certifies vertical-datum compatibility with GCC inverts. Missing/incompatible stages remain disclosed rather than borrowing offshore sea level.
- `npm run hindcast:2015` is a first-class regression target, and production-parser results are cross-checked against the independent audit parser for the full scenario matrix.

The latest production-fixed 8-link Velachery stress runs (still using current infrastructure and no reviewed 2015 downstream stage) are:

| Rain case | Production-fixed result |
|---|---:|
| Nungambakkam observed-shape proxy | threshold flooding at one node (~0.01 h; report volume rounds to 0.000 x 10^6 L) |
| Taramani 300 mm proxy | threshold flooding at one node (~0.01 h; report volume rounds to 0.000 x 10^6 L) |
| Chembarambakkam 474.9 mm stress | 1 flooded node, ~628 m3 overflow, 5.39 h, max SWMM ponded depth 1.629 m |
| Nungambakkam 294 mm uniform over 24 h | no flooding |

The earlier 1,357 m3 audit-only stress result used the pre-production junction/storage generator while correcting only dimensions/enclosure. The 628 m3 value above is the correct result from the fully patched production generator; neither is a validated historical street-depth prediction.

## Headline result

The original production configuration could strongly under-predict a 2015-style event for structural reasons. The software defects found here are now regression-covered; remaining error is dominated by missing/uncertain historical topology, catchments, terrain/land use, rainfall, and river/reservoir boundary data rather than EPA SWMM numerical instability.

### Eight-link Velachery component, large-catchment sensitivity

| Rain case | Current raw dimensions | GIS `drain_size` + closed conduit | Corrected overflow |
|---|---:|---:|---:|
| Nungambakkam observed-shape proxy, 293.9 mm/24 h | no flooding | 1 flooded node | 235 m3, 5.19 h, max ponding 0.397 m |
| Taramani 300 mm proxy | no flooding | 1 flooded node | 259 m3, 5.74 h, max ponding 0.422 m |
| Chembarambakkam 474.9 mm stress | no flooding | 1 flooded node | 1,357 m3, 12.78 h, max ponding 2.804 m |
| Nungambakkam 294 mm uniform over 24 h | no flooding | no flooding | 0 m3 |

The equal-total Nungambakkam cases demonstrate that temporal concentration matters: 294 mm concentrated in the reconstructed observed shape produces flooding while the same total distributed uniformly does not.

## Critical failure modes

### 1. Drain dimension scale is wrong for a material Velachery subset

Production ingestion requests `drain_wid` and `drain_dep` but not `drain_size`/`drain_detl`, then uses the raw numeric fields directly as metres.

For several Velachery records the GCC service returns, for example:

```text
objectid 6026
drain_wid = 7.29
drain_dep = 7.29
drain_size = 0.729 x 0.729
drain_detl = Closed
```

Using 7.29 m x 7.29 m instead of 0.729 m x 0.729 m inflates cross-sectional area by about 100x. In the queried pilot envelope, 74 of 1,336 records with parseable `drain_size` differ materially from the raw width/depth fields; 68 are approximately 10x in width, including 62 Velachery records.

This is the primary reason the raw 8-link 475 mm stress case shows virtually unloaded conduits and zero flooding while the corrected case surcharges/floods.

### 2. Closed drains are modelled as open rectangular channels

The current SWMM generator uses `RECT_OPEN` for mapped drains. The affected GCC features report `drain_detl = Closed`. The audit's corrected cases use `RECT_CLOSED`.

This changes crown/surcharge behavior and is hydraulically material.

### 3. Network catchment area is under-sized

For scenario SWMM, cFLOWS computes a catchment prior only for the selected segment and passes that as the total area for the whole local network. `buildNetworkInp()` then divides it among all links.

For the tested 8-link Velachery component:

- current app-style total area: 0.866 ha
- sum of the same per-reach priors: 8.126 ha
- difference: about 9.38x

With corrected drain dimensions and the Nungambakkam observed-shape forcing, 0.866 ha produces no flooding; 8.126 ha produces 235 m3 of overflow over 5.19 h.

The real fix is catchment delineation, not summing reach priors, but the sensitivity proves the current area assumption is capable of suppressing flooding entirely.

### 4. Production SWMM report parser misses real flooding

The corrected 475 mm report contains:

```text
J005 flooded 12.78 h
maximum flood rate 0.166 CMS
total flood volume 1.357 x 10^6 L
maximum ponded depth 2.804 m
```

Yet calling the production `parseSwmmReport()` on that exact report currently returns:

```json
{"flooded":[],"maxFloodVolumeM3":0,"solved":true}
```

The parser's section regex terminates on the decorative `*****` line immediately after the section title. Its token positions also do not match the SWMM 5.2 flooding table. Therefore valid SWMM flooding can be silently reported to the app as zero.

### 5. The selected pilot drain is spatially remote and isolated

At the tested map focus (12.9824, 80.2090), the nearest complete hydraulic GCC feature is `gcc-5878`, about 634 m away, and its geometry-derived connected component has only one segment.

The raster radius is 480 m. The surface-spill code nevertheless permits a finite drain-removal contribution from a drain beyond that radius because proximity is clamped to a nonzero minimum.

This means the displayed local street scenario can be influenced by a drain outside the modeled surface neighborhood.

### 6. Geometry topology is too fragmented for a city drainage hindcast

From 1,041 complete hydraulic features in the cached pilot set:

- 1,717 geometry nodes
- 254 high-confidence coincident-endpoint geometry links
- 0 surveyed/confirmed links
- nearest selected component: 1 link
- nearest connected component: 3 links
- largest useful Velachery component in this audit: 8 links

This is adequate for local stress experiments, not a 2015 citywide drainage reproduction.

## Boundary and process failure modes

### 7. 2015 reservoir/river forcing is absent

The local SWMM model has no Chembarambakkam reservoir hydrograph, Adyar River reach, floodplain, or river-to-drain backwater coupling. The CAG audit records a 29,000 cusec release for 21 continuous hours on 1-2 December 2015. That is approximately 62.1 million m3 of released water.

The audit's strongest corrected local SWMM overflow is only about 1,357 m3. These are different physical processes and scales; local rainfall-runoff SWMM cannot reproduce reservoir/river flooding by adjusting a drain parameter.

### 8. SWMM outfalls are unconstrained `FREE` boundaries

Every terminal geometry node is connected to an artificial free outfall. No 2015 tide, Adyar/Buckingham Canal stage, or downstream flood level is applied.

This systematically favors drainage during exactly the event conditions when downstream levels and backwater can reduce or reverse drainage.

### 9. Production forcing is a two-hour synthetic storm

The normal cFLOWS SWMM generator uses two equal rain values at 00:00 and 00:30, then zero, with a two-hour simulation. It cannot directly replay the multi-day 2015 event.

The hindcast harness extends SWMM to 48 hours. The result that equal 294 mm totals give different flood outcomes depending on temporal distribution proves that daily totals or a two-hour synthetic storm are insufficient for 2015 validation.

### 10. Antecedent November wetness is not replayed

The December simulation does not reproduce the prior November storm sequence, catchment storage, groundwater, waterbody levels, or progressively saturated drainage system. Chennai had already experienced exceptional November rainfall before the 1-2 December event.

## Surface model findings

Using the cached 5x5 Open-Elevation samples and current model priors, the hour-by-hour surface screening gives:

| Case | Max screening depth | Max area above 5 cm |
|---|---:|---:|
| Nungambakkam observed-shape | 0.94 m | 0.060 km2 |
| Taramani 300 mm proxy | 0.96 m | 0.061 km2 |
| Chembarambakkam stress | 1.07 m | 0.142 km2 |
| Nungambakkam uniform 294 mm | 0.87 m | 0.036 km2 |

Aggregate mass-balance error is effectively zero in these runs, so the surface solver is numerically mass-conserving. That does not make the depths physically validated: the 5x5 elevation field cannot resolve kerbs, walls, culverts, building barriers, underpasses, or historical 2015 terrain/land use.

### 11. Historical land-use/infrastructure mismatch

The hindcast uses current GCC drain geometry and current Overture building footprints. Those are 2026-era inputs, not a reconstruction of the drainage network and urban surface as they existed in December 2015.

This is a fundamental hindcast error source even if all numerical parameters were otherwise correct.

## Validation errors that cannot yet be calculated

The workspace registers the 2015 NRSC RISAT cumulative inundation layer and Cartosat post-event imagery, but has not extracted/georeferenced them into machine-readable labels. Therefore cFLOWS cannot yet compute:

- inundation IoU
- precision / recall / false-alarm rate against 2015 extent
- local flood-depth MAE/RMSE
- arrival-time error
- recession-time error

Any single accuracy percentage for the 2015 event would currently be fabricated.

## Remaining priority work

1. Delineate actual subcatchments from authoritative drainage/catchment data; the per-reach summed prior is only a safer interim assumption.
2. Supply a reviewed, datum-compatible 2015 Adyar/Buckingham/outfall stage series through `data/boundary/chennai-2015.json`; without it the historical SWMM outfall remains disclosed `FREE`.
3. Add a hydraulically reviewed river/reservoir model before using the Chembarambakkam release hydrograph. The local drain network deliberately does not inject the reservoir release into an arbitrary drain.
4. Import raw timestamped 2015 rain-gauge/IMERG forcing and antecedent November conditions instead of the digitised sensitivity hyetographs.
5. Import the 2015 NRSC inundation extent and independent depth observations, then calculate spatial/depth/timing error metrics.
6. Reconstruct 2015 land use and 2015-era drainage infrastructure for a genuine hindcast.

## Bottom line

EPA SWMM itself remained numerically stable with very small global continuity errors. The largest 2015 hindcast failures are upstream/downstream of the solver: source-field interpretation, catchment assignment, topology, boundary conditions, historical forcing, and result parsing.

The 2015 event is therefore an excellent regression target. With the corrected GIS dimensions and a larger plausible catchment, the model begins to produce the expected surcharge/flooding behavior; the remaining task is to make that physically and spatially faithful enough to compare against observed 2015 inundation.

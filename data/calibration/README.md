# Calibration and validation input contract

Place verified historical flood observations in `flood-observations.csv` before
claiming any depth accuracy. Every record must be time-matched to sub-daily
rainfall. Daily IMD rainfall can screen historical events but cannot calibrate
an hourly drainage/surface model.

For classification validation, provide at least 20 independent held-out rows:

`timestamp,district,latitude,longitude,observed_flooded,depth_m,predicted_flooded,predicted_depth_m,source,event_id,split`

For actual depth calibration, cFLOWS requires **explicitly separated data**:

- at least 10 rows with `split=train` (or `calibration`)
- at least 20 different rows with `split=holdout` (or `test`/`validation`)
- `raw_model_depth_m` (or `predicted_depth_m`) and verified `depth_m`

cFLOWS fits one bounded multiplicative depth-scale parameter on the training
rows only, then reports MAE/RMSE on the holdout rows. It deliberately does not
auto-split events, because observations from the same storm can leak into both
sets and make accuracy appear better than it is.

Until both the sub-daily rainfall requirement and the train/holdout depth gate
are satisfied, the UI must describe output as an exploratory screening band,
not a calibrated street-depth prediction.

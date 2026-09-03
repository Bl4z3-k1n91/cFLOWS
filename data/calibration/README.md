# Calibration input contract

Place verified historical flood observations in `flood-observations.csv` before
claiming any depth accuracy. Required columns are:

`timestamp,latitude,longitude,depth_m,flooded,source,confidence,district`

Rows must be time-matched to sub-daily rainfall. Daily IMD rainfall is useful
for event screening but cannot calibrate an hourly drainage or street-spill
model on its own.
For a publishable hindcast, import at least 20 held-out observations with
`timestamp,district,latitude,longitude,observed_flooded,depth_m,predicted_flooded,predicted_depth_m,source,event_id`.
The evaluator reports precision, recall, false-alarm rate and depth MAE only
when this gate is met. The included CSV is an empty-schema example, not a label.

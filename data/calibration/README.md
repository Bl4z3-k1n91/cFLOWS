# Calibration input contract

Place verified historical flood observations in `flood-observations.csv` before
claiming any depth accuracy. Required columns are:

`timestamp,latitude,longitude,depth_m,flooded,source,confidence,district`

Rows must be time-matched to sub-daily rainfall. Daily IMD rainfall is useful
for event screening but cannot calibrate an hourly drainage or street-spill
model on its own.

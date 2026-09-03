'use strict';

const NRSC_CHENNAI_EVENTS = [
  {
    id: 'nrsc-chennai-2015-risat-cumulative', eventId: 'TN-2015-DEC', dateRange: '2015-12-03 to 2015-12-06',
    title: 'Cumulative inundation — Chennai floods', sensor: 'RISAT-1', kind: 'official satellite inundation raster',
    layerId: 'ch_exp_0306dec15', mapService: 'tilecache2', centre: [80.23, 13.04],
    sourceUrl: 'https://bhuvan-app1.nrsc.gov.in/disaster/usrtasks/flood/flood.php?uname=empty',
    calibrationUse: 'evidence-only', limitation: 'Public map layer is rendered as a raster service; no machine-readable flood polygon or depth value has been verified for import.',
  },
  {
    id: 'nrsc-chennai-2015-cartosat-post-event', eventId: 'TN-2015-DEC', dateRange: '2015-12-04',
    title: 'Post-event Chennai imagery', sensor: 'Cartosat-2', kind: 'official post-event reference raster',
    layerId: 'ch_c2_sat', mapService: 'tilecache2', centre: [80.25, 13.15],
    sourceUrl: 'https://bhuvan-app1.nrsc.gov.in/disaster/usrtasks/flood/flood.php?uname=empty',
    calibrationUse: 'reference-only', limitation: 'Post-event imagery is corroborating reference material, not a flood/not-flood label by itself.',
  },
  {
    id: 'nrsc-chennai-2021-inundation-map', eventId: '15-FL-2021-TN', dateRange: '2021-11-13',
    title: 'Inundated area — part of Chennai City', sensor: 'Cartosat-2E-MX', kind: 'official inundation map PDF',
    sourceUrl: 'https://www.nrsc.gov.in/sites/default/files/pdf/DMSP/Inundated%20Area%20for%20a%20part%20of%20Chennai%20City-Chennai%20corporation%20taluk-4.pdf',
    calibrationUse: 'evidence-only', limitation: 'The published map covers part of Chennai and requires georeferenced vector extraction before model calibration.',
  },
  {
    id: 'nrsc-chennai-low-lying-2016', eventId: 'NRSC-LOW-LYING-2016', dateRange: '2016-12-13',
    title: 'Low-lying vulnerable areas — Chennai', sensor: 'NRSC spatial layer', kind: 'long-term vulnerability prior',
    layerId: 'low_lying_chennai_13122016_v1', mapService: 'https://bhuvan-ras2.nrsc.gov.in/cgi-bin/mapserv.exe?map=/ms4w/apps/mapfiles/disaster_hyd.map', centre: [80.01, 12.90],
    sourceUrl: 'https://bhuvan-app1.nrsc.gov.in/disaster/usrtasks/flood/flood.php?uname=empty',
    calibrationUse: 'prior-only', limitation: 'A low-lying-area layer indicates susceptibility, not observed flood occurrence on a date.',
  },
];

function getHistoricalEvidenceRegistry() {
  return {
    source: 'NRSC/ISRO Bhuvan public disaster archive',
    events: NRSC_CHENNAI_EVENTS,
    usableLabelCount: 0,
    status: 'official-evidence-awaiting-georeferenced-label-extraction',
    conclusion: 'Official Chennai flood-history evidence is registered. It is not used to calibrate cFLOWS until a georeferenced flood/not-flood extent with event time is imported and reviewed.',
  };
}

module.exports = { NRSC_CHENNAI_EVENTS, getHistoricalEvidenceRegistry };

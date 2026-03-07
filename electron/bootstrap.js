const isRecorderServiceMode =
  process.argv.includes('--recorder-service') ||
  process.env.TRACKER_RECORDER_SERVICE === 'true';

if (isRecorderServiceMode) {
  require('./recorderServiceMain');
} else {
  require('./main');
}

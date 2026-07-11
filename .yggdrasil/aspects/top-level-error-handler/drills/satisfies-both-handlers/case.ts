process.on('unhandledRejection', () => {
  process.exit(1);
});

try {
  program.parse(process.argv);
} catch (e) {
  process.stderr.write('Error: ' + String(e));
  process.exit(1);
}

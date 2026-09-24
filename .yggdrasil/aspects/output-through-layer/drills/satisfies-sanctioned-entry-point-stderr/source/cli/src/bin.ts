process.on('unhandledRejection', (reason) => {
  process.stderr.write(`error[internal]: ${String(reason)}\n`);
  process.exit(1);
});

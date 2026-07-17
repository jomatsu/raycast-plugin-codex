#!/usr/bin/env node
import { CliError, main } from '../dist/cli.js';

try {
  process.exitCode = await main(process.argv);
} catch (error) {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}

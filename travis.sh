#!/bin/bash
#set -o errexit

cd cli && \
npm install && \
./node_modules/.bin/flow && \
npm run test-quick && \
node dist/cli.js validate-defs && \
node dist/cli.js run-tests

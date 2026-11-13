// A port nothing is listening on, from the OS rather than from hope.
//
// Every harness that starts a daemon used to pick a number and trust it.
// `agents.mjs` took 7991 and reported 11/24 whenever it ran straight after
// the test suite, because a daemon the suite had started was still letting go
// of that port — a failure indistinguishable from a real one, which cost an
// afternoon before anyone suspected the port.
//
// Asking the OS for a free port and closing it leaves a gap before the daemon
// binds, so this is not airtight. It is a race against the rest of the
// machine rather than a near-certainty against the suite's own leftovers.

import { createServer } from "node:net";

export async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Several at once, for a harness that starts more than one daemon. */
export async function freePorts(count) {
  const held = [];
  try {
    for (let index = 0; index < count; index += 1) held.push(await hold());
    return held.map((server) => server.address().port);
  } finally {
    // Held open until every port is chosen, so two of them cannot come back
    // the same, then all released together.
    for (const server of held) server.close();
  }
}

function hold() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

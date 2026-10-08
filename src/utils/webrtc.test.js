// The connection policy, against a fake connection: no real WebRTC.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebRTCConnectionManager, webrtcConnectionManager as liveManager } from './webrtc';
import { endSession } from '../actions/session';
import { createRoutingServices } from '../routing/services';
import { runNavigationEffects } from '../routing/effects';

const A = 'aaaaaaaaaaaaaaaa';

const B = 'bbbbbbbbbbbbbbbb';
let opened;

function fakeConnection() {
  const conn = {
    connectionState: 'connecting',
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(() => {
      conn.connectionState = 'disconnected';
    }),
    enableVideo: vi.fn(),
    enableJoystick: vi.fn()
  };
  opened.push(conn);
  return conn;
}
let manager;

beforeEach(() => {
  opened = [];
  manager = new WebRTCConnectionManager({
    createConnection: fakeConnection
  });
});

describe('stream connection policy', () => {
  it('a cold stream link opens one connection, shared by the early handshake and the page', () => {
    manager.enterStream(A); // App, as soon as auth is ready
    manager.enterStream(A); // navigation effect
    manager.acquire(A, {}); // the stream page subscribing
    expect(opened).toHaveLength(1);
    expect(opened[0].connect).toHaveBeenCalledWith(A, true);
  });

  it('a prewarmed body connection is reused when the stream page opens', () => {
    manager.prewarm(A);
    manager.enterStream(A);
    expect(opened).toHaveLength(1);
  });

  it('leaving keeps a comma body warm and returning reuses it', () => {
    manager.enterStream(A);
    manager.leaveStream(A, {
      keepWarm: true
    });
    expect(opened[0].disconnect).not.toHaveBeenCalled();
    manager.enterStream(A);
    expect(opened).toHaveLength(1);
  });

  it("leaving closes a car's connection", () => {
    manager.enterStream(A);
    manager.leaveStream(A, {
      keepWarm: false
    });
    expect(opened[0].disconnect).toHaveBeenCalled();
    expect(manager.connection).toBeNull();
  });

  it('leaving a stream page for another device does not touch the current one', () => {
    manager.enterStream(B);
    manager.leaveStream(A, {
      keepWarm: false
    });
    expect(opened[0].disconnect).not.toHaveBeenCalled();
  });

  it("selecting another device closes the old device's connection, even a warm one", () => {
    manager.prewarm(A);
    manager.deviceChanged(B);
    expect(opened[0].disconnect).toHaveBeenCalled();
    manager.deviceChanged(B); // nothing open for B: nothing to do
    expect(opened).toHaveLength(1);
  });

  it('an explicit retry always opens a fresh connection', () => {
    manager.enterStream(A);
    manager.reconnect(A);
    expect(opened).toHaveLength(2);
    expect(opened[0].disconnect).toHaveBeenCalled();
  });
});

// Opening or retrying the transport must preserve stream ownership.

describe('stream ownership', () => {
  it('a cold enter keeps the stream owner after opening the transport', () => {
    manager.enterStream(A);
    expect(manager.streamDongleId).toBe(A);
  });

  it('explicit stream retry keeps the stream owner', () => {
    manager.prewarm(A);
    manager.enterStream(A);
    expect(manager.streamDongleId).toBe(A);
    manager.reconnect(A);
    expect(manager.streamDongleId).toBe(A);
  });

  it('a real release, disconnect or device change clears it', () => {
    manager.enterStream(A);
    manager.leaveStream(A, {
      keepWarm: true
    });
    expect(manager.streamDongleId).toBeNull();
    manager.enterStream(A);
    manager.disconnect();
    expect(manager.streamDongleId).toBeNull();
    manager.enterStream(A);
    manager.deviceChanged(B);
    expect(manager.streamDongleId).toBeNull();
  });

  // the real exported manager and the real navigation effects; only the
  // transport and the effect dispatch boundary are faked
  const leaveColdStream = notCar => {
    liveManager.disconnect();
    const originalFactory = liveManager.createConnection;
    liveManager.createConnection = fakeConnection;
    try {
      liveManager.enterStream(A);
      const connection = liveManager.connection;
      runNavigationEffects(null, {
        base: {
          view: 'dashboard',
          dongleId: A
        },
        commands: {}
      }, {
        isCurrent: () => true,
        isLatest: () => true,
        previousDongleId: A,
        getState: () => ({
          dongleId: A,
          limit: 5,
          entities: {
            devices: {
              [A]: {
                dongle_id: A,
                rpc: {
                  not_car: notCar
                }
              }
            },
            deviceOrder: [A]
          }
        }),
        dispatch: vi.fn(),
        services: {
          commands: {
            pairTokens: new Set()
          }
        }
      });
      // read before the cleanup below disconnects everything
      return {
        disconnected: connection.disconnect.mock.calls.length > 0,
        kept: liveManager.connection === connection,
        owner: liveManager.streamDongleId
      };
    } finally {
      liveManager.disconnect();
      liveManager.createConnection = originalFactory;
    }
  };
  it('leaving a cold SPA stream closes the actual car transport', () => {
    const {
      disconnected,
      kept
    } = leaveColdStream(false);
    expect(disconnected).toBe(true);
    expect(kept).toBe(false);
  });

  it('leaving a cold SPA stream keeps a comma body warm and releases ownership', () => {
    const {
      disconnected,
      kept,
      owner
    } = leaveColdStream(true);
    expect(disconnected).toBe(false);
    expect(kept).toBe(true);
    expect(owner).toBeNull();
  });
});

describe('invalid exit and logout on actual manager', () => {
  it('invalid destination still closes the old car transport', () => {
    liveManager.disconnect();
    const factory = liveManager.createConnection;
    liveManager.createConnection = fakeConnection;
    try {
      liveManager.enterStream(A);
      const connection = liveManager.connection;
      runNavigationEffects(null, {
        base: {
          view: 'invalid',
          dongleId: null
        },
        commands: {}
      }, {
        isCurrent: () => true,
        isLatest: () => true,
        previousDongleId: A,
        getState: () => ({
          dongleId: A,
          entities: {
            devices: {
              [A]: {
                dongle_id: A,
                rpc: {
                  not_car: false
                }
              }
            },
            deviceOrder: []
          }
        }),
        dispatch: vi.fn(),
        services: {
          commands: {
            pairTokens: new Set()
          }
        }
      });
      expect(connection.disconnect).toHaveBeenCalled();
      expect(liveManager.streamDongleId).toBeNull();
    } finally {
      liveManager.disconnect();
      liveManager.createConnection = factory;
    }
  });

  it('ending auth session tears down actual stream transport', () => {
    liveManager.disconnect();
    const factory = liveManager.createConnection;
    liveManager.createConnection = fakeConnection;
    try {
      liveManager.enterStream(A);
      const connection = liveManager.connection;
      endSession()(vi.fn(), () => ({
        sessionEpoch: 0
      }), createRoutingServices());
      expect(connection.disconnect).toHaveBeenCalled();
      expect(liveManager.streamDongleId).toBeNull();
    } finally {
      liveManager.disconnect();
      liveManager.createConnection = factory;
    }
  });
});

// The connection policy, against a fake connection: no real WebRTC.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WebRTCConnectionManager } from './webrtc';

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';

let opened;
function fakeConnection() {
  const conn = {
    connectionState: 'connecting',
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(() => { conn.connectionState = 'disconnected'; }),
    enableVideo: vi.fn(),
    enableJoystick: vi.fn(),
  };
  opened.push(conn);
  return conn;
}

let manager;
beforeEach(() => {
  opened = [];
  manager = new WebRTCConnectionManager({ createConnection: fakeConnection });
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
    manager.leaveStream(A, { keepWarm: true });
    expect(opened[0].disconnect).not.toHaveBeenCalled();
    manager.enterStream(A);
    expect(opened).toHaveLength(1);
  });

  it("leaving closes a car's connection", () => {
    manager.enterStream(A);
    manager.leaveStream(A, { keepWarm: false });
    expect(opened[0].disconnect).toHaveBeenCalled();
    expect(manager.connection).toBeNull();
  });

  it('leaving a stream page for another device does not touch the current one', () => {
    manager.enterStream(B);
    manager.leaveStream(A, { keepWarm: false });
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

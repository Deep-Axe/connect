import { expect, it } from 'vitest';
import { createInitialState } from './initialState';
import { selectDevices } from './selectors';

it('independent stores keep their device collection references when reads alternate', () => {
  const makeState = (id) => {
    const state = createInitialState();
    state.entities.devices = { [id]: { dongle_id: id } };
    state.entities.deviceOrder = [id];
    return state;
  };
  const a = makeState('aaaaaaaaaaaaaaaa');
  const b = makeState('bbbbbbbbbbbbbbbb');
  const devicesA = selectDevices(a);
  const devicesB = selectDevices(b);
  expect(selectDevices(a)).toBe(devicesA);
  expect(selectDevices(b)).toBe(devicesB);
  expect(devicesA).not.toBe(devicesB);
});

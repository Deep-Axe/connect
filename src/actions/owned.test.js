import { expect, it, vi } from 'vitest';
import { ownedDispatch, captureOperation } from './owned';
it('old leases reject nested thunk execution, not merely their final actions',()=>{
 let state={sessionEpoch:0}; const sideEffect=vi.fn();
 const dispatch=(a)=>typeof a==='function'?a(dispatch,()=>state):a;
 const owned=ownedDispatch(dispatch,()=>state);
 state={sessionEpoch:1};owned(()=>sideEffect());
 expect(sideEffect).not.toHaveBeenCalled();expect(owned.isCurrent()).toBe(false);
});
it('resource leases survive query edits while exact-location task leases do not',()=>{
 let state={sessionEpoch:0,dongleId:'A',nav:{location:{base:'A'}}};
 const dispatch=(a)=>typeof a==='function'?a(dispatch,()=>state):a;
 const resource=dispatch(captureOperation({resource:s=>s.dongleId==='A'}));
 const task=dispatch(captureOperation({resource:s=>s.dongleId==='A',location:true}));
 state={...state,nav:{location:{base:'A',modal:'settings'}}};
 expect(resource.isCurrent()).toBe(true);expect(task.isCurrent()).toBe(false);
 state={...state,sessionEpoch:1};expect(resource.isCurrent()).toBe(false);
});

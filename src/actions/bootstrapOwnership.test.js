import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MyCommaAuth, { storage as AuthStorage } from '@commaai/my-comma-auth';
import { bootstrapSession } from './session';
import reducer from '../reducers/globalState';
import { createInitialState } from '../initialState';
import { createRoutingServices } from '../routing/services';
const mocks=vi.hoisted(()=>({logout:vi.fn(),navigate:vi.fn()}));
vi.mock('../api/backend',()=>({api:{auth:{isAuthenticated:()=>true,logOut:mocks.logout},account:{getProfile:async()=>{throw {resp:{status:401}};}},devices:{listDevices:async()=>[]}}}));
vi.mock('../api',()=>({request:{configure:vi.fn()},athena:{configure:vi.fn()},billing:{configure:vi.fn()}}));
vi.mock('../utils/webrtc',()=>({webrtcConnectionManager:{disconnect:vi.fn()}}));
vi.mock('../utils/navigation',()=>({hardNavigate:mocks.navigate}));
beforeEach(()=>vi.clearAllMocks());
afterEach(()=>{vi.restoreAllMocks();window.history.replaceState({},'','/');});
it('BOOTSTRAP actual SDK refuses to redirect a successor session after delayed credential removal',async()=>{
 let complete;const storage=vi.spyOn(AuthStorage,'logOut').mockImplementation(()=>new Promise(resolve=>complete=resolve));
 const errors=vi.spyOn(console,'error').mockImplementation(()=>{});mocks.logout.mockImplementation(()=>MyCommaAuth.logOut());
 window.history.replaceState({},'','/new-session');
 let state={...createInitialState(),profile:{id:'old'},router:{location:{pathname:'/public',search:'?ext=1',hash:'#keep'}}};
 const services=createRoutingServices();const dispatch=action=>typeof action==='function'?action(dispatch,()=>state,services):(state=reducer(state,action),action);
 const pending=dispatch(bootstrapSession());await Promise.resolve();await Promise.resolve();await Promise.resolve();
 expect(storage).toHaveBeenCalled();expect(state.profile).toBeNull();expect(state.sessionEpoch).toBe(1);state={...state,sessionEpoch:state.sessionEpoch+1,profile:{id:'new'}};
 complete();await pending;
 expect(errors.mock.calls.some(([error])=>String(error).includes('Not implemented: navigation'))).toBe(false);
 expect(mocks.navigate).not.toHaveBeenCalled();expect(state.profile).toEqual({id:'new'});
});

it('a current rejected bootstrap clears private data before storage and reloads the full URL',async()=>{
 let complete;vi.spyOn(AuthStorage,'logOut').mockImplementation(()=>new Promise(resolve=>complete=resolve));
 let state={...createInitialState(),profile:{id:'private'},router:{location:{pathname:'/public',search:'?ext=1',hash:'#keep'}}};
 const services=createRoutingServices();const dispatch=action=>typeof action==='function'?action(dispatch,()=>state,services):(state=reducer(state,action),action);
 const pending=dispatch(bootstrapSession());await Promise.resolve();await Promise.resolve();await Promise.resolve();
 expect(state.profile).toBeNull();expect(state.sessionEpoch).toBe(1);expect(mocks.navigate).not.toHaveBeenCalled();
 complete();await pending;expect(mocks.navigate).toHaveBeenCalledWith('/public?ext=1#keep');expect(mocks.logout).not.toHaveBeenCalled();
});

it('FINAL_REVIEW rejected bootstrap waits for persisted purge before reload',async()=>{
 vi.spyOn(AuthStorage,'logOut').mockResolvedValue();let finish;
 let state={...createInitialState(),router:{location:{pathname:'/public',search:'?kept=1',hash:'#anchor'}}};const services=createRoutingServices();
 services.assetCache={clear:()=>new Promise(resolve=>finish=resolve)};
 const dispatch=action=>typeof action==='function'?action(dispatch,()=>state,services):(state=reducer(state,action),action);
 const pending=dispatch(bootstrapSession());await Promise.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();
 const redirected=mocks.navigate.mock.calls.length;finish();await pending;expect(redirected).toBe(0);
});

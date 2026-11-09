export type Day = 'wkd' | 'sat' | 'sun';
export type ModeKey = 'subway' | 'bus' | 'express' | 'rail' | 'path' | 'ferry' | 'classic' | 'ebike' | 'uber' | 'taxi';
export type Membership = 'annual' | 'member' | 'nonmember';

export interface Params {
  origin: number;
  day: Day;
  depSec: number;
  horizonMin: number;
  tripsPerWeek: number;
  countReturn: boolean;
  otherRides: number;
  tipUber: number;      // percent
  tipTaxi: number;      // percent
  taxiWaitMin: number;
  includeFirstWait: boolean;
  membership: Membership;
  modes: Record<ModeKey, boolean>;
}

/** Option kinds stored per tile. */
export const K_WALK = 0, K_CLASSIC = 1, K_EBIKE = 2, K_TRANSIT = 3, K_UBER = 4, K_TAXI = 5;

export interface QueryResult {
  id: number;
  n: number;
  off: Int32Array;      // N+1
  dur: Float32Array;    // seconds
  cost: Float32Array;   // dollars
  kind: Uint8Array;
  ms: number;
  stats: { labels: number; runs: number };
}

export interface Leg {
  mode: string;          // walk | subway | bus | express | rail | path | ferry | free | classic | ebike | uber | taxi
  name: string;          // route short name or description
  color: string;
  secs: number;
  cost?: number;
  from?: string;
  to?: string;
  note?: string;
}

export interface Explain {
  tile: number;
  zone: string;
  dur: number;
  cost: number;
  kind: number;
  legs: Leg[];
}

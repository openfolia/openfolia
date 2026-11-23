import type { Request } from 'express';
import { clientAddress } from '../../base/api/client-address.js';
import type { DeliveryClient } from '../core/delivery-limit.js';

/**
 * Who asks, for the stable addresses' rate limit (`DeliveryLimit`, #574): the actor when the
 * request has one (a token), else the client's address (`clientAddress`; an IPv6 one by its /56).
 */
export const deliveryClient = (req: Request): DeliveryClient =>
  req.actor ? { actor: req.actor } : { address: clientAddress(req, 56) };

import type { Request } from 'express';
import { READER } from '../../../tests/fakes/actors.js';
import { deliveryClient } from './delivery-client.js';

describe('deliveryClient (#574)', () => {
  const request = (fields: Record<string, unknown>) =>
    ({
      socket: { remoteAddress: '198.51.100.1' },
      ...fields,
    }) as unknown as Request;

  it('is the actor when the request has one, else the address Express names', () => {
    expect(
      deliveryClient(request({ actor: READER, ip: '203.0.113.7' })),
    ).toEqual({ actor: READER });
    expect(deliveryClient(request({ ip: '203.0.113.7' }))).toEqual({
      address: '203.0.113.7',
    });
    expect(deliveryClient(request({}))).toEqual({ address: '198.51.100.1' });
  });
});

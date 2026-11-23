import { TestBed } from '@angular/core/testing';

import { MeService } from '../permissions/me';
import { ImageSources } from './image-sources';
import { ImageThumbComponent } from './image-thumb.component';

const person = (id: string) =>
  TestBed.inject(MeService).set({
    id,
    kind: 'user',
    name: id,
    role: '',
    permissions: new Set(['content.read']),
  });

describe('ImageThumbComponent', () => {
  it('asks for its image again for the next person, never keeping the one shown before (#716)', async () => {
    const source = vi.fn((asset: string) =>
      Promise.resolve(`blob:${TestBed.inject(MeService).me().id}:${asset}`),
    );
    TestBed.configureTestingModule({
      providers: [{ provide: ImageSources, useValue: { source } }],
    });
    person('u1');
    const fixture = TestBed.createComponent(ImageThumbComponent);
    fixture.componentRef.setInput('asset', `sha256:${'c'.repeat(64)}`);
    await fixture.whenStable();
    const img = () =>
      (fixture.nativeElement as HTMLElement).querySelector('img');
    expect(source).toHaveBeenCalledTimes(1);
    expect(img()?.getAttribute('src')).toContain('blob:u1:');

    person('u2');
    await fixture.whenStable();
    expect(source).toHaveBeenCalledTimes(2);
    expect(img()?.getAttribute('src')).toContain('blob:u2:');
  });
});

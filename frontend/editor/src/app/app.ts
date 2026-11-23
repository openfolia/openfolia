import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { RouteFadeDirective, ThemeService } from '@openfolia/ui/startup';

import { BrandingService } from './branding/branding.service';

@Component({
  selector: 'of-root',
  imports: [RouterOutlet, RouteFadeDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<router-outlet ofRouteFade />`,
})
export class App {
  constructor() {
    // Light, dark or the device's setting, on every page (the account menu changes it).
    inject(ThemeService);
    // The favicon and the brand's colours come from the branding (#169: the API's, over the
    // config's defaults), not from index.html. (`/favicon.ico`, the default brand's, is only
    // what a browser asks for when it can read no icon link.)
    inject(BrandingService);
  }
}

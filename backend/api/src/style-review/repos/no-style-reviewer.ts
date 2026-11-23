import { Injectable } from '@nestjs/common';
import {
  type ProposedSuggestion,
  StyleReviewer,
} from '../core/style-reviewer.js';

/**
 * The default: no model is configured, so the style review is off and
 * nothing is ever sent anywhere (the action answers 404 `not-configured`
 * before it reads anything).
 */
@Injectable()
export class NoStyleReviewer extends StyleReviewer {
  readonly configured = false;

  review(): Promise<readonly ProposedSuggestion[]> {
    return Promise.reject(new Error('The style review is not configured.'));
  }
}

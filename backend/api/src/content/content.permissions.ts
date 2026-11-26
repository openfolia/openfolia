import { definePermissions } from '../access/core/permission-registry.js';

/** Reading and changing content in Git, and its review (`src/permissions.ts` registers them). */
export const CONTENT_PERMISSIONS = definePermissions('content', [
  {
    key: 'content.read',
    labelKey: 'editor.admin.permissions.contentRead',
    description: 'Read released content (`main` and release tags).',
    read: true,
  },
  {
    key: 'content.read.draft',
    labelKey: 'editor.admin.permissions.contentReadDraft',
    description: 'Read anything else: drafts on other branches and commits.',
    read: true,
  },
  {
    key: 'content.edit',
    labelKey: 'editor.admin.permissions.contentEdit',
    description: 'Change content (open and edit change sets).',
  },
  {
    key: 'content.review',
    labelKey: 'editor.admin.permissions.contentReview',
    description: 'Review a change.',
  },
  {
    key: 'content.approve',
    labelKey: 'editor.admin.permissions.contentApprove',
    description: 'Sign off a change; restricted module types need it.',
  },
]);

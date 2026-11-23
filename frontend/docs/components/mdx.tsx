import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { OpenAPIDownload } from './openapi-download';
import { ChangelogRelease } from './changelog-release';
import { AgentInstall } from './agent-install';

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    OpenAPIDownload,
    ChangelogRelease,
    AgentInstall,
    ...components,
  };
}

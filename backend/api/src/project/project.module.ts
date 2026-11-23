import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module.js';
import { ProjectController } from './api/project.controller.js';
import { GetConfigAction } from './core/actions/get-config.action.js';
import { ListConfigUsagesAction } from './core/actions/list-config-usages.action.js';
import { ListRefsAction } from './core/actions/list-refs.action.js';

@Module({
  imports: [ContentModule],
  controllers: [ProjectController],
  providers: [ListRefsAction, GetConfigAction, ListConfigUsagesAction],
})
export class ProjectModule {}

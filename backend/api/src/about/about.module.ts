import { Module } from '@nestjs/common';
import { AboutController } from './api/about.controller.js';

/** `GET /about`: the licence and where the source is (#370). */
@Module({ controllers: [AboutController] })
export class AboutModule {}

import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { PermissionMetadataValidator } from './permission-metadata.validator.js';

// Startup check of Staff route permission metadata (12.1).
@Module({
  imports: [DiscoveryModule],
  providers: [PermissionMetadataValidator],
})
export class RbacModule {}

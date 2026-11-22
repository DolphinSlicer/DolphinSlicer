// User-facing text for engine errors, by error code.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { SliceError } from '../engine/types';
import { t, tr } from '../i18n/i18n';

export interface ErrorText {
  title: string;
  message: string;
  detail?: string;
  code?: string;
}

export function describeError(e: unknown): ErrorText {
  if (!(e instanceof SliceError)) {
    const msg = String((e as Error)?.message ?? e);
    return { title: t('Something went wrong'), message: tr(msg), detail: (e as Error)?.stack ?? '' };
  }
  const detail = e.detail || undefined;
  switch (e.code) {
    case 'OOM':
      return { code: e.code, title: t('Out of memory'), message: t('Try fewer or smaller objects, or a larger layer height.'), detail };
    case 'VALIDATE_ERROR':
      return { code: e.code, title: t('Cannot slice with these settings'), message: tr(e.message), detail };
    case 'EMPTY_PLATE':
      return {
        code: e.code,
        title: t('Nothing on the plate'),
        message: t('No object is fully on the bed. Move it there or use Arrange.'),
        detail,
      };
    case 'INVALID_INPUT':
      return { code: e.code, title: t('Could not read the model'), message: tr(e.message), detail };
    case 'INVALID_CONFIG':
      return { code: e.code, title: t('Settings rejected'), message: tr(e.message), detail };
    case 'SLICE_FAILED':
      return { code: e.code, title: t('Slicing failed'), message: tr(e.message), detail };
    case 'ENGINE_LOAD':
      return {
        code: e.code,
        title: t('The slicing engine could not be loaded'),
        message: t('Reload the page. If this keeps happening, your browser may be too old.'),
        detail,
      };
    case 'CANCELLED':
      return { code: e.code, title: t('Canceled'), message: t('Slicing was canceled.') };
    default:
      return { code: e.code, title: t('Slicing engine crashed'), message: t('Please try again.'), detail };
  }
}

import { describe, expect, it } from 'vitest';
import { scanVerbatim, verbatimMissing } from './verbatim.ts';

describe('scanVerbatim', () => {
  it('collects literal confirmation texts from Blade templates, skipping bound or echoed values', () => {
    const files = [
      { path: 'a.blade.php', text: '<x-modal-confirmation confirmationText="cleanup deleted backups" :confirmationLabel="__(\'x\')" />' },
      { path: 'b.blade.php', text: '<x-modal-confirmation confirmationText="Update All Packages" /> <x-modal-confirmation confirmationText="{{ $resource->name }}" />' },
      { path: 'c.blade.php', text: '<x-modal-confirmation :confirmationText="$name" /> <x-modal-confirmation confirmationText="cleanup deleted backups" />' },
    ];

    expect(scanVerbatim(files)).toEqual(['Update All Packages', 'cleanup deleted backups']);
  });
});

describe('verbatimMissing', () => {
  it('names literals the English shows but the translation dropped', () => {
    const literals = ['cleanup deleted backups', 'Update All Packages'];

    expect(verbatimMissing("Please confirm by typing 'cleanup deleted backups' below", "아래에 '삭제된 백업 정리'를 입력하여 확인하세요", literals)).toEqual(['cleanup deleted backups']);
    expect(verbatimMissing("Please confirm by typing 'cleanup deleted backups' below", "아래에 'cleanup deleted backups'를 입력해 확인하세요", literals)).toEqual([]);
    expect(verbatimMissing('Update packages', '패키지 업데이트', literals)).toEqual([]);
  });
});

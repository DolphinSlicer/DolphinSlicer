// The model library: cards with thumbnails, search by name or tag, open on the plate.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Box, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { t } from '../i18n/i18n';
import type { LibraryEntry } from '../library/store';
import { readNow } from '../state/actions';
import { addModels, deleteModel, openModel, updateModel } from '../state/libraryActions';
import { useApp } from '../state/store';
import { ask } from './Confirm';
import { formatBytes } from './format';

/** Every word must be in the name, file name or a tag. */
export function matches(e: LibraryEntry, query: string, tags: string[]): boolean {
  if (tags.some((tag) => !e.tags.includes(tag))) return false;
  const hay = [e.name, e.file, ...e.tags].join(' ').toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export function LibraryView() {
  const models = useApp((s) => s.models);
  const [query, setQuery] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const allTags = useMemo(() => [...new Set(models.entries.flatMap((e) => e.tags))].sort((a, b) => a.localeCompare(b)), [models.entries]);
  // A picked tag that no model has any more no longer filters (its chip is gone).
  const shown = models.entries.filter((e) =>
    matches(
      e,
      query,
      tags.filter((tag) => allTags.includes(tag)),
    ),
  );
  const toggleTag = (tag: string) => setTags((l) => (l.includes(tag) ? l.filter((x) => x !== tag) : [...l, tag]));

  return (
    <div className="settings library" role="region" aria-label={t('Model library')} data-testid="library">
      <div className="settings-head">
        <h2 className="library-title">
          {t('Model library')}
          {models.entries.length > 0 && <span className="count">{models.entries.length}</span>}
        </h2>
        <label className="search">
          <Search size={15} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search models')}
            aria-label={t('Search models')}
            data-testid="library-search"
          />
        </label>
        <div className="settings-actions">
          {models.adding.length > 0 && <span className="spinner" aria-label={t('Adding models')} data-testid="library-adding" />}
          <button className="btn primary" onClick={() => input.current?.click()} data-testid="library-add">
            <Plus size={15} />
            {t('Add models')}
          </button>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          accept=".stl,.3mf,.obj,.amf"
          hidden
          data-testid="library-input"
          onChange={(e) => {
            void addModels(readNow([...(e.target.files ?? [])]));
            e.target.value = '';
          }}
        />
      </div>
      {allTags.length > 0 && (
        <div className="settings-tools tag-filter" data-testid="library-tags">
          {allTags.map((tag) => (
            <button
              key={tag}
              className={`chip${tags.includes(tag) ? ' on' : ''}`}
              aria-pressed={tags.includes(tag)}
              onClick={() => toggleTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      <div className="library-body">
        {models.loaded && !models.entries.length ? (
          <div className="library-empty">
            <Box size={28} />
            <p>{t('No models yet. Add STL or 3MF files, or save the models on your plate.')}</p>
          </div>
        ) : models.entries.length > 0 && !shown.length ? (
          <div className="library-empty">
            <p>{t('No models match.')}</p>
          </div>
        ) : (
          <ul className="model-grid" data-testid="library-grid">
            {shown.map((e) => (
              <ModelCard key={e.id} e={e} editing={editing === e.id} onEdit={(on) => setEditing(on ? e.id : null)} onTag={toggleTag} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ModelCard({
  e,
  editing,
  onEdit,
  onTag,
}: {
  e: LibraryEntry;
  editing: boolean;
  onEdit: (on: boolean) => void;
  onTag: (tag: string) => void;
}) {
  const opening = useApp((s) => s.models.opening.includes(e.id));
  const [name, setName] = useState(e.name);
  const [tagText, setTagText] = useState(e.tags.join(', '));
  const startEdit = () => {
    setName(e.name);
    setTagText(e.tags.join(', '));
    onEdit(true);
  };
  const save = () => {
    void updateModel(e.id, { name, tags: tagText.split(',') });
    onEdit(false);
  };
  return (
    <li className="model-card" data-testid="library-card" data-name={e.name}>
      <button
        className="model-open"
        onClick={() => void openModel(e.id)}
        disabled={opening}
        data-tip={t('Open on the plate')}
        aria-label={t('Open {name}', { name: e.name })}
      >
        {e.thumb ? <img src={e.thumb} alt="" draggable={false} /> : <Box size={40} className="model-noimg" />}
        {opening && <span className="spinner model-busy" />}
      </button>
      {editing ? (
        <form
          className="model-edit"
          onSubmit={(ev) => {
            ev.preventDefault();
            save();
          }}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') {
              ev.stopPropagation();
              onEdit(false);
            }
          }}
        >
          <input
            type="text"
            value={name}
            onChange={(ev) => setName(ev.target.value)}
            aria-label={t('Name')}
            autoFocus
            data-testid="library-name"
          />
          <input
            type="text"
            value={tagText}
            onChange={(ev) => setTagText(ev.target.value)}
            placeholder={t('Tags, separated by commas')}
            aria-label={t('Tags')}
            data-testid="library-tags-input"
          />
          <div className="model-edit-actions">
            <button type="button" className="btn small ghost" onClick={() => onEdit(false)}>
              {t('Cancel')}
            </button>
            <button type="submit" className="btn small primary" data-testid="library-save">
              {t('Save')}
            </button>
          </div>
        </form>
      ) : (
        <div className="model-info">
          <div className="model-name" data-tip={e.name}>
            {e.name}
          </div>
          <div className="model-meta muted small">
            {e.file.split('.').pop()!.toUpperCase()} · {formatBytes(e.size)}
          </div>
          {e.tags.length > 0 && (
            <div className="model-tags">
              {e.tags.map((tag) => (
                <button key={tag} className="chip small" onClick={() => onTag(tag)}>
                  {tag}
                </button>
              ))}
            </div>
          )}
          <div className="model-actions">
            <button
              className="icon-btn small"
              onClick={startEdit}
              aria-label={t('Edit {name}', { name: e.name })}
              data-tip={t('Edit')}
              data-testid="library-edit"
            >
              <Pencil size={14} />
            </button>
            <button
              className="icon-btn small"
              aria-label={t('Delete {name}', { name: e.name })}
              data-tip={t('Delete')}
              data-testid="library-delete"
              onClick={async () => {
                if (await ask(t('Delete {name} from the library?', { name: e.name }), { confirm: t('Delete'), danger: true }))
                  void deleteModel(e.id);
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

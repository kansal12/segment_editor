/**
 * Segment Editor Application
 * Waveform-based audio segment editing tool
 */

// Global state
const state = {
    chunks: [],
    segments: [],
    currentChunkId: 1,
    currentChunk: null,
    selectedSegmentId: null,
    wavesurfer: null,
    regions: null,
    undoStack: [],
    deletedSegments: [], // Segments deleted locally, pending save
    hasUnsavedChanges: false,
    playSelectedEndTime: null, // End time for play-selected mode
    playSelectedListener: null, // Listener for stopping at region end
};

// DOM Elements
const elements = {
    waveform: document.getElementById('waveform'),
    timeline: document.getElementById('timeline'),
    segmentsBody: document.getElementById('segmentsBody'),
    currentChunk: document.getElementById('currentChunk'),
    totalChunks: document.getElementById('totalChunks'),
    currentTime: document.getElementById('currentTime'),
    duration: document.getElementById('duration'),
    selectedInfo: document.getElementById('selectedInfo'),
    status: document.getElementById('status'),
    playPauseBtn: document.getElementById('playPauseBtn'),
    playSelectedBtn: document.getElementById('playSelectedBtn'),
    prevChunkBtn: document.getElementById('prevChunkBtn'),
    nextChunkBtn: document.getElementById('nextChunkBtn'),
    jumpSegmentInput: document.getElementById('jumpSegmentInput'),
    jumpSegmentBtn: document.getElementById('jumpSegmentBtn'),
    zoomInBtn: document.getElementById('zoomInBtn'),
    zoomOutBtn: document.getElementById('zoomOutBtn'),
    zoomFitBtn: document.getElementById('zoomFitBtn'),
    chunkPath: document.getElementById('chunkPath'),
    saveBtn: document.getElementById('saveBtn'),
    undoBtn: document.getElementById('undoBtn'),
    deleteBtn: document.getElementById('deleteBtn'),
    projectName: document.getElementById('projectName'),
};

// API Functions
const api = {
    async getProject() {
        const response = await fetch('/api/project');
        return response.json();
    },

    async getChunks() {
        const response = await fetch('/api/chunks');
        return response.json();
    },

    async getSegments(chunkId) {
        const response = await fetch(`/api/segments?chunk_id=${chunkId}`);
        return response.json();
    },

    async updateSegment(segmentId, updates) {
        const response = await fetch(`/api/segments/${segmentId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });
        return response.json();
    },

    getAudioUrl(chunkId) {
        return `/api/audio/${chunkId}`;
    },

    async deleteSegment(segmentId) {
        const response = await fetch(`/api/segments/${segmentId}`, {
            method: 'DELETE',
        });
        return response.json();
    },
};

// Utility Functions
function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(2);
    return `${mins.toString().padStart(2, '0')}:${secs.padStart(5, '0')}`;
}

function setStatus(message, type = '') {
    elements.status.textContent = message;
    elements.status.className = 'status ' + type;
    if (type === 'saved') {
        setTimeout(() => {
            elements.status.textContent = '';
            elements.status.className = 'status';
        }, 3000);
    }
}

// Initialize WaveSurfer
function initWaveSurfer() {
    // Create regions plugin
    state.regions = WaveSurfer.Regions.create();

    // Create WaveSurfer instance
    state.wavesurfer = WaveSurfer.create({
        container: elements.waveform,
        waveColor: '#4F4A85',
        progressColor: '#8be9fd',
        cursorColor: '#fff',
        height: 128,
        normalize: true,
        plugins: [
            state.regions,
            WaveSurfer.Timeline.create({
                container: elements.timeline,
                primaryColor: '#888',
                secondaryColor: '#555',
                primaryFontColor: '#888',
                secondaryFontColor: '#555',
            }),
        ],
    });

    // WaveSurfer events
    state.wavesurfer.on('ready', () => {
        elements.duration.textContent = formatTime(state.wavesurfer.getDuration());
        createRegions();
    });

    state.wavesurfer.on('audioprocess', () => {
        elements.currentTime.textContent = formatTime(state.wavesurfer.getCurrentTime() + state.currentChunk?.start_time);
    });

    state.wavesurfer.on('seeking', () => {
        elements.currentTime.textContent = formatTime(state.wavesurfer.getCurrentTime() + state.currentChunk?.start_time);
    });

    state.wavesurfer.on('play', () => {
        elements.playPauseBtn.textContent = 'Pause';
        elements.playPauseBtn.classList.add('playing');
    });

    state.wavesurfer.on('pause', () => {
        elements.playPauseBtn.textContent = 'Play';
        elements.playPauseBtn.classList.remove('playing');

        // Clean up play-selected listener if active
        if (state.playSelectedListener) {
            state.wavesurfer.un('audioprocess', state.playSelectedListener);
            state.playSelectedListener = null;
            state.playSelectedEndTime = null;
        }
    });

    // Region events
    state.regions.on('region-clicked', (region, e) => {
        e.stopPropagation();
        selectSegment(region.id);
    });

    state.regions.on('region-updated', (region) => {
        handleRegionUpdate(region);
    });
}

// Create regions for segments
function createRegions() {
    // Clear existing regions
    state.regions.clearRegions();

    if (!state.currentChunk) return;

    const chunkStart = state.currentChunk.start_time;

    state.segments.forEach(segment => {
        const localStart = segment.start_sec - chunkStart;
        const localEnd = segment.end_sec - chunkStart;

        // Skip if segment is outside this chunk
        if (localEnd < 0 || localStart > state.wavesurfer.getDuration()) return;

        const isGap = segment.gap_type && segment.gap_type !== '';
        const isSelected = segment.segment_id === state.selectedSegmentId;

        const region = state.regions.addRegion({
            id: segment.segment_id.toString(),
            start: Math.max(0, localStart),
            end: Math.min(state.wavesurfer.getDuration(), localEnd),
            color: isGap ? 'rgba(136, 136, 136, 0.3)' : 'rgba(79, 74, 133, 0.4)',
            drag: true,
            resize: true,
        });

        // Listen for live updates during drag/resize
        region.on('update', () => {
            updateTableRowLive(segment.segment_id, region);
        });
    });

    // Highlight selected region if any
    if (state.selectedSegmentId) {
        highlightRegion(state.selectedSegmentId);
    }
}

// Handle region update (drag/resize)
function handleRegionUpdate(region) {
    const segmentId = parseInt(region.id);
    const segment = state.segments.find(s => s.segment_id === segmentId);
    if (!segment) return;

    const chunkStart = state.currentChunk.start_time;
    const newStartSec = region.start + chunkStart;
    const newEndSec = region.end + chunkStart;

    // Save to undo stack
    state.undoStack.push({
        segmentId,
        oldStart: segment.start_sec,
        oldEnd: segment.end_sec,
    });
    elements.undoBtn.disabled = false;

    // Update local state
    segment.start_sec = newStartSec;
    segment.end_sec = newEndSec;

    // Update table
    updateTableRow(segmentId);

    // Mark as having unsaved changes
    state.hasUnsavedChanges = true;

    // Save to server
    saveSegmentUpdate(segmentId, { start_sec: newStartSec, end_sec: newEndSec });
}

// Save segment update to server
async function saveSegmentUpdate(segmentId, updates) {
    setStatus('Saving...', 'saving');
    try {
        await api.updateSegment(segmentId, updates);
        setStatus('Saved', 'saved');
    } catch (error) {
        console.error('Failed to save:', error);
        setStatus('Save failed', 'error');
    }
}

// Save all changes including deletions
async function saveAll() {
    const deletedCount = state.deletedSegments.length;

    if (deletedCount === 0) {
        setStatus('All changes saved', 'saved');
        state.hasUnsavedChanges = false;
        return;
    }

    setStatus('Saving deletions...', 'saving');

    try {
        // Delete all pending segments from server
        for (const segmentId of state.deletedSegments) {
            await api.deleteSegment(segmentId);
        }

        // Clear deleted segments list
        state.deletedSegments = [];

        // Clear undo stack for deletions (they are now permanent)
        state.undoStack = state.undoStack.filter(item => item.type !== 'delete');
        elements.undoBtn.disabled = state.undoStack.length === 0;

        setStatus(`Saved (${deletedCount} segment${deletedCount > 1 ? 's' : ''} deleted)`, 'saved');
        state.hasUnsavedChanges = false;
    } catch (error) {
        console.error('Failed to save deletions:', error);
        setStatus('Save failed', 'error');
    }
}

// Select segment
function selectSegment(segmentId) {
    const id = typeof segmentId === 'string' ? parseInt(segmentId) : segmentId;
    state.selectedSegmentId = id;

    // Find the segment first
    // Use == for type coercion since segment_id might be string or number
    const segment = state.segments.find(s => s.segment_id == id);

    // Enable/disable delete button immediately
    const deleteBtn = document.getElementById('deleteBtn');
    if (deleteBtn) {
        // Disable if no segment found or if segment is already marked for deletion
        deleteBtn.disabled = !segment || segment.markedForDeletion;
    }

    // Update selection info
    if (segment) {
        const duration = (segment.end_sec - segment.start_sec).toFixed(2);
        const status = segment.markedForDeletion ? ' (marked for deletion)' : '';
        elements.selectedInfo.textContent = `Selected: Segment ${id} | Duration: ${duration}s${status}`;
    }

    // Update table selection
    document.querySelectorAll('#segmentsBody tr').forEach(row => {
        row.classList.toggle('selected', parseInt(row.dataset.segmentId) === id);
    });

    try {
        // Highlight region
        highlightRegion(id);

        // Zoom and center waveform on the segment
        zoomToSegment(id);
    } catch (e) {
        console.error('Error in selectSegment:', e);
    }

    // Scroll table row into view
    if (segment) {
        const row = document.querySelector(`#segmentsBody tr[data-segment-id="${id}"]`);
        if (row) {
            row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
}

// Delete the currently selected segment (mark as deleted with strikethrough)
function deleteSelectedSegment() {
    if (!state.selectedSegmentId) return;

    const segmentId = state.selectedSegmentId;
    // Use == for type coercion since segment_id might be string or number
    const segmentIndex = state.segments.findIndex(s => s.segment_id == segmentId);
    if (segmentIndex === -1) return;

    const segment = state.segments[segmentIndex];

    // If already deleted, do nothing
    if (segment.markedForDeletion) return;

    // Save to undo stack
    state.undoStack.push({
        type: 'delete',
        segmentId: segmentId,
    });
    elements.undoBtn.disabled = false;

    // Mark segment for deletion (don't remove yet)
    segment.markedForDeletion = true;

    // Add to deleted segments list (for saving to server later)
    state.deletedSegments.push(segmentId);

    // Update region appearance (make it red/faded)
    const regions = state.regions.getRegions();
    for (const region of regions) {
        if (region.id === segmentId.toString()) {
            region.setOptions({ color: 'rgba(255, 0, 0, 0.3)' });
            break;
        }
    }

    // Update table row with strikethrough
    const row = document.querySelector(`#segmentsBody tr[data-segment-id="${segmentId}"]`);
    if (row) {
        row.classList.add('deleted');
    }

    // Update UI
    elements.selectedInfo.textContent = 'Segment marked for deletion (undo available)';
    state.hasUnsavedChanges = true;

    // Enable finalize button
    const finalizeBtn = document.getElementById('finalizeBtn');
    if (finalizeBtn) {
        finalizeBtn.disabled = false;
    }

    // Move to next segment
    const nextSegment = state.segments.find((s, i) => i > segmentIndex && !s.markedForDeletion);
    const prevSegment = [...state.segments].reverse().find((s, i) => state.segments.length - 1 - i < segmentIndex && !s.markedForDeletion);
    if (nextSegment) {
        selectSegment(nextSegment.segment_id);
    } else if (prevSegment) {
        selectSegment(prevSegment.segment_id);
    } else {
        state.selectedSegmentId = null;
        const deleteBtn = document.getElementById('deleteBtn');
        if (deleteBtn) deleteBtn.disabled = true;
    }
}

// Finalize deletions - actually remove marked segments
async function finalizeDeletes() {
    const deletedSegments = state.segments.filter(s => s.markedForDeletion);

    if (deletedSegments.length === 0) {
        setStatus('No segments to finalize', 'saved');
        return;
    }

    setStatus('Finalizing deletions...', 'saving');

    try {
        // Delete from server
        for (const segment of deletedSegments) {
            await api.deleteSegment(segment.segment_id);
        }

        // Remove from local state
        state.segments = state.segments.filter(s => !s.markedForDeletion);

        // Remove regions from waveform
        const regions = state.regions.getRegions();
        for (const region of regions) {
            const segmentId = parseInt(region.id);
            if (deletedSegments.some(s => s.segment_id == segmentId)) {
                region.remove();
            }
        }

        // Clear deleted segments list
        state.deletedSegments = [];

        // Clear undo stack for deletions
        state.undoStack = state.undoStack.filter(item => item.type !== 'delete');
        elements.undoBtn.disabled = state.undoStack.length === 0;

        // Re-render table
        renderTable();

        // Disable finalize button
        const finalizeBtn = document.getElementById('finalizeBtn');
        if (finalizeBtn) {
            finalizeBtn.disabled = true;
        }

        setStatus(`Deleted ${deletedSegments.length} segment${deletedSegments.length > 1 ? 's' : ''}`, 'saved');
        state.hasUnsavedChanges = false;
    } catch (error) {
        console.error('Failed to finalize deletions:', error);
        setStatus('Failed to delete segments', 'error');
    }
}

// Highlight region on waveform
function highlightRegion(segmentId) {
    const regions = state.regions.getRegions();
    regions.forEach(region => {
        const isSelected = parseInt(region.id) === segmentId;
        const segment = state.segments.find(s => s.segment_id === parseInt(region.id));
        const isGap = segment && segment.gap_type && segment.gap_type !== '';

        if (isSelected) {
            region.setOptions({ color: 'rgba(255, 215, 0, 0.5)' });
        } else {
            region.setOptions({
                color: isGap ? 'rgba(136, 136, 136, 0.3)' : 'rgba(79, 74, 133, 0.4)'
            });
        }
    });
}

// Zoom and center waveform on a segment
function zoomToSegment(segmentId) {
    const segment = state.segments.find(s => s.segment_id === segmentId);
    if (!segment || !state.currentChunk) return;

    const chunkStart = state.currentChunk.start_time;
    const localStart = segment.start_sec - chunkStart;
    const localEnd = segment.end_sec - chunkStart;
    const segmentDuration = localEnd - localStart;
    const totalDuration = state.wavesurfer.getDuration();

    // Get the waveform container width
    const containerWidth = elements.waveform.clientWidth;

    // Calculate zoom level so segment occupies ~50% of visible area (range: 30-70%)
    const targetRatio = 0.5;
    const visibleDuration = segmentDuration / targetRatio;

    // Calculate pixels per second needed
    const pxPerSec = containerWidth / visibleDuration;

    // Clamp zoom level to reasonable bounds
    const minZoom = containerWidth / totalDuration; // Fit all
    const maxZoom = 500; // Max zoom level
    const clampedPxPerSec = Math.max(minZoom, Math.min(maxZoom, pxPerSec));

    // Calculate the center of the segment (as ratio of total duration)
    const segmentCenter = (localStart + localEnd) / 2;
    const centerRatio = segmentCenter / totalDuration;

    // Apply zoom
    state.wavesurfer.zoom(clampedPxPerSec);

    // Center the view on the segment after zoom applies
    centerOnTime(centerRatio, clampedPxPerSec, containerWidth);

    // Seek cursor to segment start
    state.wavesurfer.seekTo(localStart / totalDuration);
}

// Center the waveform view on a specific time ratio
function centerOnTime(timeRatio, pxPerSec, containerWidth) {
    const totalDuration = state.wavesurfer.getDuration();

    // Calculate total width at this zoom level
    const totalWidth = pxPerSec * totalDuration;

    // Calculate where the center point is in pixels
    const centerPx = timeRatio * totalWidth;

    // Calculate scroll position to center this point
    const targetScroll = centerPx - (containerWidth / 2);
    const maxScroll = Math.max(0, totalWidth - containerWidth);
    const clampedScroll = Math.max(0, Math.min(targetScroll, maxScroll));

    // Function to apply the scroll
    const applyScroll = () => {
        // Try WaveSurfer's setScroll method first (if available)
        if (typeof state.wavesurfer.setScroll === 'function') {
            state.wavesurfer.setScroll(clampedScroll);
        } else {
            // Fallback to manual scroll
            const wrapper = state.wavesurfer.getWrapper();
            if (wrapper) {
                // The scroll container is typically the wrapper itself or its parent
                let scrollElement = wrapper;
                // Check if wrapper has overflow, otherwise check parent
                if (wrapper.scrollWidth <= wrapper.clientWidth && wrapper.parentElement) {
                    scrollElement = wrapper.parentElement;
                }
                scrollElement.scrollLeft = clampedScroll;
            }
        }
    };

    // Apply immediately
    applyScroll();

    // Apply again after short delays to override any WaveSurfer auto-scroll
    setTimeout(applyScroll, 0);
    setTimeout(applyScroll, 20);
    setTimeout(applyScroll, 50);
    setTimeout(applyScroll, 100);
}

// Render segments table
function renderTable() {
    elements.segmentsBody.innerHTML = '';

    const chunkStart = state.currentChunk?.start_time || 0;

    state.segments.forEach(segment => {
        const row = document.createElement('tr');
        row.dataset.segmentId = segment.segment_id;

        if (segment.gap_type && segment.gap_type !== '') {
            row.classList.add('gap');
        }

        if (segment.segment_id === state.selectedSegmentId) {
            row.classList.add('selected');
        }

        // const localStart = segment.start_sec - chunkStart;
        // const localEnd = segment.end_sec - chunkStart;
        const localStart = segment.start_sec ;
        const localEnd = segment.end_sec ;

        row.innerHTML = `
            <td class="col-id">${segment.segment_id}</td>
            <td class="col-start time-cell">${localStart.toFixed(2)}</td>
            <td class="col-end time-cell">${localEnd.toFixed(2)}</td>
            <td class="col-text text-cell" data-segment-id="${segment.segment_id}">${escapeHtml(segment.text || '')}</td>
        `;

        // Row click to select
        row.addEventListener('click', (e) => {
            if (!e.target.classList.contains('text-cell') || e.target.classList.contains('editing')) {
                selectSegment(segment.segment_id);
            }
        });

        // Double-click on text cell to edit
        const textCell = row.querySelector('.text-cell');
        textCell.addEventListener('dblclick', () => startTextEdit(textCell, segment));

        // Double-click time cells to edit
        const timeCells = row.querySelectorAll('.time-cell');
        timeCells.forEach(cell => {
            cell.addEventListener('dblclick', () => startTimeEdit(cell, segment));
        });

        elements.segmentsBody.appendChild(row);
    });
}

// Update single table row
function updateTableRow(segmentId) {
    const segment = state.segments.find(s => s.segment_id === segmentId);
    if (!segment) return;

    const row = document.querySelector(`#segmentsBody tr[data-segment-id="${segmentId}"]`);
    if (!row) return;

    const chunkStart = state.currentChunk?.start_time || 0;
    const localStart = segment.start_sec;
    const localEnd = segment.end_sec ;
    // const localStart = segment.start_sec - chunkStart;
    // const localEnd = segment.end_sec - chunkStart;

    row.querySelector('.col-start').textContent = localStart.toFixed(2);
    row.querySelector('.col-end').textContent = localEnd.toFixed(2);
}

// Update table row live during drag (before state is updated)
function updateTableRowLive(segmentId, region) {
    const row = document.querySelector(`#segmentsBody tr[data-segment-id="${segmentId}"]`);
    if (!row) return;

    const chunkStart = state.currentChunk?.start_time || 0;
    const liveStart = region.start + chunkStart;
    const liveEnd = region.end + chunkStart;

    row.querySelector('.col-start').textContent = liveStart.toFixed(2);
    row.querySelector('.col-end').textContent = liveEnd.toFixed(2);
}

// Text editing
function startTextEdit(cell, segment) {
    if (cell.classList.contains('editing')) return;

    cell.classList.add('editing');
    const originalText = segment.text || '';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = originalText;

    cell.innerHTML = '';
    cell.appendChild(input);
    input.focus();
    input.select();

    const finishEdit = async (save) => {
        if (!cell.classList.contains('editing')) return;

        const newText = input.value;
        cell.classList.remove('editing');
        cell.textContent = save ? newText : originalText;

        if (save && newText !== originalText) {
            // Save to undo stack
            state.undoStack.push({
                segmentId: segment.segment_id,
                oldText: originalText,
            });
            elements.undoBtn.disabled = false;

            // Update local state
            segment.text = newText;

            // Save to server
            await saveSegmentUpdate(segment.segment_id, { text: newText });
        }
    };

    input.addEventListener('blur', () => finishEdit(true));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            finishEdit(true);
        } else if (e.key === 'Escape') {
            finishEdit(false);
        }
    });
}

// Text editing
function startTimeEdit(cell, segment) {
    if (cell.classList.contains('editing')) return;
    const isStart = cell.classList.contains('col-start');

    cell.classList.add('editing');
    const originalTime = isStart? segment.start_sec : segment.end_sec ;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = originalTime.toFixed(2);

    cell.innerHTML = '';
    cell.appendChild(input);
    input.focus();
    input.select();

    const finishEdit = async (save) => {
        if (!cell.classList.contains('editing')) return;

        const newTime = input.value;
        cell.classList.remove('editing');
        cell.textContent = save ? newTime : originalTime.toFixed(2);

        if (save && newTime !== originalTime.toFixed(2)) {

            // Save to undo stack
            state.undoStack.push({
                segmentId: segment.segment_id,
                time: originalTime.toFixed(2),
            });
            elements.undoBtn.disabled = false;

            // Update local state
            if(isStart){
                segment.start_time = parseFloat(newTime);
            }else{
                segment.end_time = parseFloat(newTime);
            }

            // Save to server
            await saveSegmentUpdate(segment.segment_id, { start_time: segment.start_time, end_time: segment.end_time });
        }
    };

    input.addEventListener('blur', () => finishEdit(true));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            finishEdit(true);
        } else if (e.key === 'Escape') {
            finishEdit(false);
        }
    });
}

// Escape HTML for display
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Load chunk
async function loadChunk(chunkId) {
    setStatus('Loading...', 'saving');

    // Get chunk metadata
    state.currentChunk = state.chunks.find(c => c.chunk_id === chunkId);
    if (!state.currentChunk) {
        setStatus('Chunk not found', 'error');
        return;
    }

    state.currentChunkId = chunkId;
    elements.currentChunk.textContent = chunkId;

    // Display chunk file path
    const filePath = state.currentChunk.file_path || '';
    const fileName = filePath.split('/').pop() || filePath;
    elements.chunkPath.textContent = fileName;
    elements.chunkPath.title = filePath;

    // Update nav button states
    elements.prevChunkBtn.disabled = chunkId <= 1;
    elements.nextChunkBtn.disabled = chunkId >= state.chunks.length;

    // Load segments for this chunk
    const segmentsData = await api.getSegments(chunkId);
    state.segments = segmentsData.segments;

    // Render table
    renderTable();

    // Load audio
    await state.wavesurfer.load(api.getAudioUrl(chunkId));

    setStatus('', '');
}

// Undo last change
async function undo() {
    if (state.undoStack.length === 0) return;

    const lastChange = state.undoStack.pop();

    // Handle delete undo (unmark segment)
    if (lastChange.type === 'delete') {
        const segmentId = lastChange.segmentId;
        const segment = state.segments.find(s => s.segment_id == segmentId);

        if (segment) {
            // Unmark for deletion
            segment.markedForDeletion = false;

            // Remove from deleted segments list
            const deletedIdx = state.deletedSegments.indexOf(segmentId);
            if (deletedIdx !== -1) {
                state.deletedSegments.splice(deletedIdx, 1);
            }

            // Restore region color
            const regions = state.regions.getRegions();
            for (const region of regions) {
                if (region.id === segmentId.toString()) {
                    const isGap = segment.gap_type && segment.gap_type !== '';
                    region.setOptions({
                        color: isGap ? 'rgba(136, 136, 136, 0.3)' : 'rgba(79, 74, 133, 0.4)'
                    });
                    break;
                }
            }

            // Remove strikethrough from table row
            const row = document.querySelector(`#segmentsBody tr[data-segment-id="${segmentId}"]`);
            if (row) {
                row.classList.remove('deleted');
            }

            // Update finalize button state
            const hasDeleted = state.segments.some(s => s.markedForDeletion);
            const finalizeBtn = document.getElementById('finalizeBtn');
            if (finalizeBtn) {
                finalizeBtn.disabled = !hasDeleted;
            }

            // Select the restored segment
            selectSegment(segmentId);
            elements.selectedInfo.textContent = `Restored: Segment ${segmentId}`;
        }
    } else {
        // Handle edit undo
        const segment = state.segments.find(s => s.segment_id === lastChange.segmentId);
        if (!segment) {
            elements.undoBtn.disabled = state.undoStack.length === 0;
            return;
        }

        const updates = {};

        if ('oldStart' in lastChange) {
            segment.start_sec = lastChange.oldStart;
            segment.end_sec = lastChange.oldEnd;
            updates.start_sec = lastChange.oldStart;
            updates.end_sec = lastChange.oldEnd;
        }

        if ('oldText' in lastChange) {
            segment.text = lastChange.oldText;
            updates.text = lastChange.oldText;
        }

        // Update UI
        renderTable();
        createRegions();
        if (state.selectedSegmentId) {
            selectSegment(state.selectedSegmentId);
        }

        // Save to server
        await saveSegmentUpdate(lastChange.segmentId, updates);
    }

    elements.undoBtn.disabled = state.undoStack.length === 0;
}

// Jump to segment
function jumpToSegment(segmentId) {
    // Find segment
    const allSegmentsResponse = fetch('/api/segments')
        .then(r => r.json())
        .then(data => {
            const segment = data.segments.find(s => s.segment_id === segmentId);
            if (segment) {
                // Load the chunk containing this segment
                if (segment.chunk_id !== state.currentChunkId) {
                    loadChunk(segment.chunk_id).then(() => {
                        setTimeout(() => selectSegment(segmentId), 500);
                    });
                } else {
                    selectSegment(segmentId);
                }
            } else {
                setStatus(`Segment ${segmentId} not found`, 'error');
            }
        });
}

// Keyboard shortcuts
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ignore if editing text
        if (e.target.tagName === 'INPUT') return;

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                state.wavesurfer.playPause();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                navigateSegment(-1);
                break;
            case 'ArrowRight':
                e.preventDefault();
                navigateSegment(1);
                break;
            case 'Enter':
                e.preventDefault();
                playSelectedSegment();
                break;
            case 'KeyZ':
                if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    undo();
                }
                break;
            case 'Delete':
            case 'Backspace':
                e.preventDefault();
                deleteSelectedSegment();
                break;
        }
    });
}

// Navigate between segments
function navigateSegment(direction) {
    const currentIndex = state.segments.findIndex(s => s.segment_id === state.selectedSegmentId);
    const newIndex = currentIndex + direction;

    if (newIndex >= 0 && newIndex < state.segments.length) {
        const segment = state.segments[newIndex];
        selectSegment(segment.segment_id);
    }
}

// Play selected segment
function playSelectedSegment() {
    if (!state.selectedSegmentId) return;

    const regions = state.regions.getRegions();
    const region = regions.find(r => parseInt(r.id) === state.selectedSegmentId);
    if (region) {
        // Store the end time to stop at
        state.playSelectedEndTime = region.end;

        // Remove any existing listener to avoid duplicates
        if (state.playSelectedListener) {
            state.wavesurfer.un('audioprocess', state.playSelectedListener);
        }

        // Create listener that stops playback at region end
        state.playSelectedListener = () => {
            const currentTime = state.wavesurfer.getCurrentTime();
            if (currentTime >= state.playSelectedEndTime) {
                state.wavesurfer.pause();
                state.wavesurfer.un('audioprocess', state.playSelectedListener);
                state.playSelectedListener = null;
                state.playSelectedEndTime = null;
            }
        };

        // Add the listener
        state.wavesurfer.on('audioprocess', state.playSelectedListener);

        // Start playing the region
        region.play();
    }
}

// Setup event listeners
function setupEventListeners() {
    elements.playPauseBtn.addEventListener('click', () => {
        state.wavesurfer.playPause();
    });

    elements.playSelectedBtn.addEventListener('click', playSelectedSegment);

    elements.prevChunkBtn.addEventListener('click', () => {
        if (state.currentChunkId > 1) {
            loadChunk(state.currentChunkId - 1);
        }
    });

    elements.nextChunkBtn.addEventListener('click', () => {
        if (state.currentChunkId < state.chunks.length) {
            loadChunk(state.currentChunkId + 1);
        }
    });

    elements.jumpSegmentBtn.addEventListener('click', () => {
        const segmentId = parseInt(elements.jumpSegmentInput.value);
        if (segmentId) {
            jumpToSegment(segmentId);
        }
    });

    elements.jumpSegmentInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const segmentId = parseInt(elements.jumpSegmentInput.value);
            if (segmentId) {
                jumpToSegment(segmentId);
            }
        }
    });

    elements.zoomInBtn.addEventListener('click', () => {
        const currentZoom = state.wavesurfer.options.minPxPerSec || 50;
        state.wavesurfer.zoom(currentZoom * 1.5);
    });

    elements.zoomOutBtn.addEventListener('click', () => {
        const currentZoom = state.wavesurfer.options.minPxPerSec || 50;
        state.wavesurfer.zoom(currentZoom / 1.5);
    });

    elements.zoomFitBtn.addEventListener('click', () => {
        state.wavesurfer.zoom(0);
    });

    elements.saveBtn.addEventListener('click', saveAll);

    elements.undoBtn.addEventListener('click', undo);

    elements.deleteBtn.addEventListener('click', deleteSelectedSegment);

    const finalizeBtn = document.getElementById('finalizeBtn');
    if (finalizeBtn) {
        finalizeBtn.addEventListener('click', finalizeDeletes);
    }

    // Warn before leaving if unsaved changes
    window.addEventListener('beforeunload', (e) => {
        if (state.hasUnsavedChanges) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
}

// Initialize application
async function init() {
    try {
        // Load project info (non-blocking)
        api.getProject().then(projectData => {
            elements.projectName.textContent = projectData.name;
        }).catch(err => {
            console.warn('Could not load project info:', err);
        });

        // Load chunks metadata
        const chunksData = await api.getChunks();
        state.chunks = chunksData.chunks;
        elements.totalChunks.textContent = state.chunks.length;

        // Initialize WaveSurfer
        initWaveSurfer();

        // Setup event listeners
        setupEventListeners();
        setupKeyboardShortcuts();

        // Load first chunk
        await loadChunk(1);

    } catch (error) {
        console.error('Failed to initialize:', error);
        setStatus('Failed to load', 'error');
    }
}

// Start the app
init();

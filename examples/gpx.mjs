#!/usr/bin/env node
/**
 * Stream a GPX track and report its length.
 *
 *   node examples/gpx.mjs
 *
 * Why streaming: recorded tracks are point clouds - tens of thousands of
 * <trkpt> with <ele>/<time> children - and a ride can be hundreds of megabytes.
 * Each point is emitted on close and dropped.
 */
import { createReadStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createStream } from 'xml-event-parser/stream';

const file = process.argv[2] ?? new URL('./data/track.gpx', import.meta.url);
const earthRadius = 6371000;
let points = 0;
let previous;
let metres = 0;

const radians = (degrees) => degrees * Math.PI / 180;

await pipeline(
    createReadStream(file),
    createStream({ event: '</gpx.trk.trkseg.trkpt>' }),
    new Writable({
        objectMode: true,
        write(point, _encoding, done) {
            const lat = Number(point.lat);
            const lon = Number(point.lon);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                points++;
                if (previous) {
                    const dLat = radians(lat - previous.lat);
                    const dLon = radians(lon - previous.lon);
                    const a = Math.sin(dLat / 2) ** 2
                        + Math.cos(radians(previous.lat)) * Math.cos(radians(lat)) * Math.sin(dLon / 2) ** 2;
                    metres += 2 * earthRadius * Math.asin(Math.sqrt(a));
                }
                previous = { lat, lon };
            }
            done();
        },
    }),
);

console.log(`${points} points, ${(metres / 1000).toFixed(2)} km`);

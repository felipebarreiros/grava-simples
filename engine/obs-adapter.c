/* Grava Simples browser adapter, created 2026-10-30. GPL-2.0-or-later.
 * Uses OBS Studio 33.0.1 graphics implementations, not a libobs runtime.
 * OBS upstream source files remain unmodified under vendor/obs/.
 */
#include <stdint.h>
#include <stddef.h>
#include <math.h>
#include <string.h>
#include "graphics/matrix4.h"
#include "graphics/vec3.h"
#include "media-io/audio-math.h"

/* Source/target coordinates: x,y,w,h,cropX,cropY,cropW,cropH. */
static float rectangles[16];

static void place(float *out, float sw, float sh, float x, float y,
                  float width, float height, int cover)
{
    float scale = cover ? fmaxf(width / sw, height / sh) : fminf(width / sw, height / sh);
    float cw = cover ? width / scale : sw;
    float ch = cover ? height / scale : sh;
    float dw = cw * scale, dh = ch * scale;
    struct matrix4 transform;
    struct vec3 origin, corner;
    matrix4_identity(&transform);
    matrix4_scale3f(&transform, &transform, scale, scale, 1.0f);
    matrix4_translate3f(&transform, &transform, x + (width - dw) / 2.0f,
                        y + (height - dh) / 2.0f, 0.0f);
    vec3_set(&origin, 0.0f, 0.0f, 0.0f);
    vec3_set(&corner, cw, ch, 0.0f);
    vec3_transform(&origin, &origin, &transform);
    vec3_transform(&corner, &corner, &transform);
    out[0] = origin.x; out[1] = origin.y;
    out[2] = corner.x - origin.x; out[3] = corner.y - origin.y;
    out[4] = (sw - cw) / 2.0f; out[5] = (sh - ch) / 2.0f;
    out[6] = cw; out[7] = ch;
}

float *obs_layout(float ow, float oh, float sw, float sh, float cw, float ch,
                  int screen_camera, int portrait)
{
    memset(rectangles, 0, sizeof(rectangles));
    if (!screen_camera) {
        place(rectangles, sw, sh, 0, 0, ow, oh, 1);
    } else if (portrait) {
        place(rectangles, sw, sh, 0, 0, ow, oh * 0.44f, 0);
        place(rectangles + 8, cw, ch, 0, oh * 0.46f, ow, oh * 0.54f, 1);
    } else {
        float padding = ow * 0.022f;
        float width = ow * 0.25f;
        float height = width * ch / cw;
        /* Very tall camera inputs still fit in the output. */
        if (height > oh * 0.4f) { height = oh * 0.4f; width = height * cw / ch; }
        place(rectangles, sw, sh, 0, 0, ow, oh, 0);
        place(rectangles + 8, cw, ch, ow - width - padding,
              oh - height - padding, width, height, 1);
    }
    return rectangles;
}

float obs_audio_gain_db(float db) { return db_to_mul(db); }

#define AUDIO_CHANNELS 2
#define AUDIO_FRAMES 2048
#define AUDIO_SLOTS 8

/* Adapted storage only; the DSP functions below are verbatim OBS functions.
 * Sidechain capture, native source registration and settings UI are excluded.
 */
struct compressor_data {
    float *envelope_buf;
    size_t envelope_buf_len;
    float ratio, threshold, attack_gain, release_gain, output_gain;
    size_t num_channels, sample_rate;
    float envelope, slope;
};
static struct compressor_data compressors[AUDIO_SLOTS];
static float audio[AUDIO_SLOTS][AUDIO_CHANNELS][AUDIO_FRAMES];
static float envelopes[AUDIO_SLOTS][AUDIO_FRAMES];

static void resize_env_buffer(struct compressor_data *cd, size_t len)
{
    /* Browser quantum sizes are bounded before entry; fixed realtime storage. */
    cd->envelope_buf_len = len <= AUDIO_FRAMES ? len : AUDIO_FRAMES;
}

#include "obs-compressor-dsp.inc"

float *obs_audio_buffer(int slot) {
    return slot >= 0 && slot < AUDIO_SLOTS ? &audio[slot][0][0] : NULL;
}

void obs_compressor_config(int slot, int rate, int channels, float ratio,
                          float threshold, float attack_ms, float release_ms, float gain_db)
{
    if (slot < 0 || slot >= AUDIO_SLOTS) return;
    struct compressor_data *cd = &compressors[slot];
    memset(cd, 0, sizeof(*cd));
    cd->envelope_buf = envelopes[slot];
    cd->envelope_buf_len = AUDIO_FRAMES;
    cd->num_channels = channels == 1 ? 1 : 2;
    cd->sample_rate = rate;
    cd->ratio = ratio;
    cd->threshold = threshold;
    cd->attack_gain = gain_coefficient(rate, attack_ms / 1000.0f);
    cd->release_gain = gain_coefficient(rate, release_ms / 1000.0f);
    cd->output_gain = db_to_mul(gain_db);
    cd->slope = 1.0f - (1.0f / ratio);
}

void obs_compressor_process(int slot, int frames)
{
    if (slot < 0 || slot >= AUDIO_SLOTS || frames <= 0 || frames > AUDIO_FRAMES) return;
    float *samples[2] = {audio[slot][0], audio[slot][1]};
    analyze_envelope(&compressors[slot], samples, frames);
    process_compression(&compressors[slot], samples, frames);
}

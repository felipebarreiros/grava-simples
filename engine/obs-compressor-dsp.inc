/* Extracted unchanged from OBS Studio 33.0.1 compressor-filter.c on 2026-10-30.
 * Source: https://github.com/obsproject/obs-studio/tree/65c320b46e1af5c7a555161aea6182cdf7a8c524
 * GPL-2.0-or-later; see vendor/obs/COPYING and full original source supplied.
 * Modifications: functions selected for browser adapter; function bodies unchanged.
 * The upstream file has no individual copyright header; OBS Project contributors.
 */
static inline float gain_coefficient(uint32_t sample_rate, float time)
{
	return (float)exp(-1.0f / (sample_rate * time));
}

static void analyze_envelope(struct compressor_data *cd, float **samples, const uint32_t num_samples)
{
	if (cd->envelope_buf_len < num_samples) {
		resize_env_buffer(cd, num_samples);
	}

	const float attack_gain = cd->attack_gain;
	const float release_gain = cd->release_gain;

	memset(cd->envelope_buf, 0, num_samples * sizeof(cd->envelope_buf[0]));
	for (size_t chan = 0; chan < cd->num_channels; ++chan) {
		if (!samples[chan])
			continue;

		float *envelope_buf = cd->envelope_buf;
		float env = cd->envelope;
		for (uint32_t i = 0; i < num_samples; ++i) {
			const float env_in = fabsf(samples[chan][i]);
			if (env < env_in) {
				env = env_in + attack_gain * (env - env_in);
			} else {
				env = env_in + release_gain * (env - env_in);
			}
			envelope_buf[i] = fmaxf(envelope_buf[i], env);
		}
	}
	cd->envelope = cd->envelope_buf[num_samples - 1];
}

static inline void process_compression(const struct compressor_data *cd, float **samples, uint32_t num_samples)
{
	for (size_t i = 0; i < num_samples; ++i) {
		const float env_db = mul_to_db(cd->envelope_buf[i]);
		float gain = cd->slope * (cd->threshold - env_db);
		gain = db_to_mul(fminf(0, gain));

		for (size_t c = 0; c < cd->num_channels; ++c) {
			if (samples[c]) {
				samples[c][i] *= gain * cd->output_gain;
			}
		}
	}
}

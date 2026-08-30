<?php
/**
 * Plugin Name: Ultrasound ECG Monitor
 * Plugin URI: https://example.com/
 * Description: Renders the ultrasound-based ECG monitor web app via shortcode [ultrasound_ecg_monitor].
 * Version: 1.0.11
 * Author: Simon Bowald
 */

if (!defined('ABSPATH')) {
    exit;
}

function uem_register_assets() {
    $plugin_url = plugin_dir_url(__FILE__);

    wp_register_style(
        'uem-ecg-style',
        $plugin_url . 'assets/style.css',
        array(),
        '1.0.11'
    );

    wp_register_script(
        'uem-ecg-script',
        $plugin_url . 'assets/script.js',
        array(),
        '1.0.11',
        true
    );
}
add_action('wp_enqueue_scripts', 'uem_register_assets');

function uem_render_shortcode($atts = array(), $content = null) {
    wp_enqueue_style('uem-ecg-style');
    wp_enqueue_script('uem-ecg-script');

    $index_file = plugin_dir_path(__FILE__) . 'index.html';

    if (!file_exists($index_file)) {
        return '<p>Ultrasound ECG Monitor: index.html not found.</p>';
    }

    $html = file_get_contents($index_file);

    if ($html === false) {
        return '<p>Ultrasound ECG Monitor: index.html could not be read.</p>';
    }

    // Use index.html as the single source for the page markup.
    // Only insert the body contents into WordPress because WordPress already
    // provides the surrounding HTML document, head and body tags.
    if (preg_match('/<body[^>]*>(.*?)<\/body>/is', $html, $matches)) {
        $html = $matches[1];
    }

    // WordPress already loads script.js via wp_enqueue_script(), so remove the
    // standalone script tag from the extracted index.html body.
    $html = preg_replace(
        '/<script[^>]*src=["\'][^"\']*assets\/script\.js["\'][^>]*><\/script>/is',
        '',
        $html
    );

    return $html;
}
add_shortcode('ultrasound_ecg_monitor', 'uem_render_shortcode');
